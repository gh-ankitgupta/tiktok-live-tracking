const mongoose = require("mongoose");

const GiftSchema = new mongoose.Schema({
  gift_name: String,
  gift_value: Number,
  quantity: Number,
});

const StreamSchema = new mongoose.Schema({
  stream_id: String,
  start_time: Date,
  end_time: Date,
  duration: Number,
  gifts: [GiftSchema],
  total_gift_value: Number,
  top_gifters: [
    {
      userId: String,
      total_diamonds: Number,
      gifts: Object,
    },
  ],
});

const HistorySchema = new mongoose.Schema({
  date: String, // YYYY-MM-DD
  streams: [StreamSchema],
  total_streams: Number,
  total_gifts_received: Number,
  total_gift_value: Number,
});

const StreamerSchema = new mongoose.Schema({
  _id: String, // Streamer's unique username or ID
  history: [HistorySchema],
});

module.exports = mongoose.model("Streamer", StreamerSchema);
