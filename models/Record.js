const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
    wsAccount: {
        type: String,
        index: true
    },
    platformAccount: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    todayDeposit: {
        type: Number,
        default: 0
    },
    monthDeposit: {
        type: Number,
        default: 0
    },
    joinDate: {
        type: String,
        default: ''
    },
    ipStatus: {
        type: String,
        default: '正常'
    },
    developer: {
        type: String,
        default: ''
    },
    receptionist: {
        type: String,
        default: ''
    },
    senderName: {
        type: String,
        required: true
    },
    senderId: {
        type: Number,
        required: true
    },
    rawMessage: {
        type: String,
        required: true
    },
    collectedAt: {
        type: Date,
        default: Date.now
    },
    collectionDate: {
        type: String,
        index: true
    },
    collectionMonth: {
        type: String,
        index: true
    }
});

module.exports = mongoose.model('Record', RecordSchema);
