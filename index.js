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
    TRACKED_STREAMERS = data.split("\n").map((line) => line.trim()).filter(Boolean);
    console.log("Loaded streamers:", TRACKED_STREAMERS);
  } catch (error) {
    console.error("Error reading streamers file:", error);
  }
}

loadStreamersFromFile();

// List of streamers to track
// const TRACKED_STREAMERS = ["j3f62zp7s717","taihezi","vexanatiktok45","diaryofmirzu", "luxuryangel_official", "m.deryyy01"]; // Replace with actual usernames
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
        
        if (!state.roomId || !state.isConnected) {
          console.log(`Detected that ${username} is no longer live.`);
          console.log(state.roomId, state.isConnected);
          endStream(username);
        }
        continue; // Skip creating a new connection if already tracking
      }

      console.log(`Attempting to connect to ${username}...`);
      const tiktokLive = new WebcastPushConnection(username);

      // Initialize connection entry
      connections.set(username, {
        live: false,
        streamStartTime: null,
        gifts: {},
        tiktokLive,
      });

      // Connect to TikTok live stream
      tiktokLive
        .connect()
        .then(() => {
          if (!connections.get(username).live) {
            console.log(`${username} started a live stream.`);
            connections.get(username).live = true;
            connections.get(username).streamStartTime = new Date();
          }
        })
        .catch((err) => {
          console.error(`Error connecting to ${username}:`, err);
          endStream(username);
        });

      // Handle gifts
      tiktokLive.on("gift", (data) => {
        try {
          if (!connections.has(username)) return;
          const { giftName, giftId, diamondCount, repeatCount } = data;
          console.log(
            `${username} received ${repeatCount}x ${giftName} (id: ${giftId}) (${diamondCount} diamonds each).`
          );

          const session = connections.get(username);
          if (!session.live) return;

          const gifts = session.gifts;
          if (!gifts[giftName]) {
            gifts[giftName] = { gift_value: diamondCount, quantity: 0 };
          }
          gifts[giftName].quantity += repeatCount;
        } catch (error) {
          console.error(`Error processing gift for ${username}:`, error);
        }
      });

      // Handle stream end
      tiktokLive.on("streamEnd", () => {
        console.log(`${username}'s stream ended (event detected).`);
        endStream(username);
      });

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
    const duration = Math.round((streamEndTime - session.streamStartTime) / 1000);
    const today = new Date().toISOString().split("T")[0];
    const totalGiftValue = Object.values(session.gifts).reduce(
      (acc, gift) => acc + gift.gift_value * gift.quantity,
      0
    );

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
