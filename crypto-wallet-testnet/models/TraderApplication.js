const mongoose = require('mongoose');

const traderApplicationSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  displayName: { type: String, required: true, trim: true, maxlength: 24 },
  bio:         { type: String, required: true, trim: true, maxlength: 300 },
  strategy:    { type: String, enum: ['swing', 'scalping', 'long-term', 'mixed'], required: true },
  experience:  { type: String, enum: ['<1', '1-3', '3-5', '5+'], required: true },
  markets:     { type: String, default: '', trim: true, maxlength: 80 },
  performanceFee: { type: Number, required: true, min: 5, max: 20 },
  status:      { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  adminNote:   { type: String, default: '' },
  reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt:  { type: Date, default: null },
  createdAt:   { type: Date, default: Date.now }
});

module.exports = mongoose.model('TraderApplication', traderApplicationSchema);
