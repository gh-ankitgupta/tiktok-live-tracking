const { WebcastPushConnection } = require("tiktok-live-connector");
const mongoose = require("mongoose");
const fs = require("fs");
const Streamer = require("./models/Streamer");
const connectDB = require("./db");
require("dotenv").config();

// Connect to MongoDB
connectDB();

const STREAMERS_FILE = "streamers.txt";
let TRACKED_STREAMERS = [];

function loadStreamersFromFile() {
  try {
    const data = fs.readFileSync(STREAMERS_FILE, "utf8");
    TRACKED_STREAMERS = data
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    console.log("Loaded streamers:", TRACKED_STREAMERS);
  } catch (error) {
    console.error("Error reading streamers file:", error);
  }
}

loadStreamersFromFile();

// List of streamers to track
// TRACKED_STREAMERS = ["tryanderrorok"]; // Replace with actual usernames
const POLLING_INTERVAL_MINUTES = process.env.POLLING_INTERVAL_MINUTES || 5; // Adjust as needed

const connections = new Map();

async function checkLiveStreams() {
  console.log("Checking for live streams...");

  for (const username of TRACKED_STREAMERS) {
    try {
      // If connection exists, check if stream is still live
      if (connections.has(username)) {
        const session = connections.get(username);
        const state = session.tiktokLive.getState(); // Get live stream state
        // console.log(state)
        if (!state.roomId || !state.isConnected) {
          console.log(`Detected that ${username} is no longer live.`);
          console.log(state.roomId, state.isConnected);
          endStream(username);
        }
        continue; // Skip creating a new connection if already tracking
      }

      console.log(`Attempting to connect to ${username}...`);
      const tiktokLive = new WebcastPushConnection(username, {
        enableWebsocketUpgrade: true,
        sessionId: "9859904da10e80024351338fe1fd5ab1",
      });
       // Get live stream state
    //   console.log(JSON.stringify(tiktokLive))
      // Initialize connection entry
      connections.set(username, {
        live: false,
        streamStartTime: null,
        gifts: {},
        tiktokLive,
      });

      // Connect to TikTok live stream
      try {
        await tiktokLive.connect();
        if (!connections.get(username).live) {
          console.log(`${username} started a live stream.`);
          connections.get(username).live = true;
          connections.get(username).streamStartTime = new Date();
        }
      } catch (err) {
        console.error(`Error connecting to ${username}:`, err);
        // console.log(String(err).includes('initial room data'));
        if (String(err).includes("initial room data")) {
          console.log(`Waiting for 1 minute before retrying ${username}...`);
          await new Promise((resolve) => setTimeout(resolve, 60000)); // 1-minute delay
        }

        endStream(username);
        continue; // Skip further processing for this username
      }

      // Handle gifts
      tiktokLive.on("gift", (data) => {
        try {
            // console.log(JSON.stringify(connections.get(username)));
          if (!connections.has(username)) return;
          
          const { giftName, giftId, diamondCount, repeatCount, uniqueId, gift } = data;
          const session = connections.get(username);
          if (!session.live) return;
      
          if (gift.gift_type === 1 && gift.repeat_end === 0) {
            // Streak in progress => show only temporary
            console.log(`${uniqueId} is sending gift: ${giftName} (${giftId}) x${gift.repeat_count} to ${username}`);
            return; // Do not count the streak progress gifts
          }
      
          // Streak ended or non-streakable gift => count the final repeat_count
          console.log(`${uniqueId} has sent gift: ${giftName} (${giftId}) x${gift.repeat_count} to ${username}`);
          
          console.log('saving the gift data!');
          // Track total gifts
          if (!session.gifts[giftName]) {
            session.gifts[giftName] = { gift_value: diamondCount, quantity: 0 };
          }
          session.gifts[giftName].quantity += repeatCount;
      
          // Track gifter contributions
          if (!session.gifters) {
            session.gifters = {};
          }
          if (!session.gifters[uniqueId]) {
            session.gifters[uniqueId] = { total_diamonds: 0, gifts: {} };
          }
          session.gifters[uniqueId].total_diamonds += diamondCount * repeatCount;
          
          if (!session.gifters[uniqueId].gifts[giftName]) {
            session.gifters[uniqueId].gifts[giftName] = { quantity: 0, value: diamondCount };
          }
          session.gifters[uniqueId].gifts[giftName].quantity += repeatCount;
      
        } catch (error) {
          console.error(`Error processing gift for ${username}:`, error);
        }
      });
      

      // Handle stream end
      tiktokLive.on("streamEnd", () => {
        console.log(`${username}'s stream ended (event detected).`);
        endStream(username);
      });

      // Delay before moving to the next streamer to prevent rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000)); // 1-second delay
    } catch (error) {
      console.error(`Error in checkLiveStreams for ${username}:`, error);
    }
  }
}

async function endStream(username) {
    try {
      if (!connections.has(username) || !connections.get(username).live) return;
  
      console.log(`${username}'s live stream ended.`);
      const session = connections.get(username);
      session.live = false;
  
      const streamEndTime = new Date();
      const duration = Math.round(
        (streamEndTime - session.streamStartTime) / 1000
      );
      const today = new Date().toISOString().split("T")[0];
  
      const totalGiftValue = Object.values(session.gifts).reduce(
        (acc, gift) => acc + gift.gift_value * gift.quantity,
        0
      );
  
      // Get top 5 gifters based on total diamonds sent
      const topGifters = Object.entries(session.gifters)
        .map(([userId, details]) => ({
          userId,
          total_diamonds: details.total_diamonds,
          gifts: details.gifts,
        }))
        .sort((a, b) => b.total_diamonds - a.total_diamonds)
        .slice(0, 5);
  
      const newStream = {
        stream_id: `${username}_${Date.now()}`,
        start_time: session.streamStartTime,
        end_time: streamEndTime,
        duration,
        gifts: Object.entries(session.gifts).map(([name, details]) => ({
          gift_name: name,
          gift_value: details.gift_value,
          quantity: details.quantity,
        })),
        total_gift_value: totalGiftValue,
        top_gifters: topGifters, // Store top 5 gifters in the stream record
      };
  
      // Save stream data to MongoDB
      const streamer = await Streamer.findById(username);
      if (!streamer) {
        await Streamer.create({
          _id: username,
          history: [
            {
              date: today,
              streams: [newStream],
              total_streams: 1,
              total_gifts_received: Object.values(session.gifts).reduce(
                (acc, gift) => acc + gift.quantity,
                0
              ),
              total_gift_value: totalGiftValue,
            },
          ],
        });
      } else {
        let todayData = streamer.history.find((h) => h.date === today);
        if (!todayData) {
          streamer.history.push({
            date: today,
            streams: [newStream],
            total_streams: 1,
            total_gifts_received: Object.values(session.gifts).reduce(
              (acc, gift) => acc + gift.quantity,
              0
            ),
            total_gift_value: totalGiftValue,
          });
        } else {
          todayData.streams.push(newStream);
          todayData.total_streams++;
          todayData.total_gifts_received += Object.values(session.gifts).reduce(
            (acc, gift) => acc + gift.quantity,
            0
          );
          todayData.total_gift_value += totalGiftValue;
        }
        await streamer.save();
      }
      console.log(`Stream data saved for ${username}.`);
  
      // Cleanup resources
      session.tiktokLive.disconnect();
      connections.delete(username);
    } catch (error) {
      console.error(`Error saving stream data for ${username}:`, error);
    }
  }
  

// Start polling every defined interval
setInterval(checkLiveStreams, POLLING_INTERVAL_MINUTES * 60 * 1000);

// Run once on startup
checkLiveStreams();
