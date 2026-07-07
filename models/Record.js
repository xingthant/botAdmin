const mongoose = require('mongoose');

const recordSchema = new mongoose.Schema({
    wsAccount: {
        type: String,
        trim: true,
        default: '',
        maxlength: 50
    },
    platformAccount: {
        type: String,
        required: [true, 'Platform account is required'],
        unique: true,
        trim: true,
        index: true,
        maxlength: 50
    },
    todayDeposit: {
        type: Number,
        default: 0,
        min: 0,
        max: 999999999 // Max 999 million
    },
    monthDeposit: {
        type: Number,
        default: 0,
        min: 0,
        max: 999999999
    },
    joinDate: {
        type: String,
        trim: true,
        default: '',
        maxlength: 50
    },
    ipStatus: {
        type: String,
        trim: true,
        default: '正常',
        maxlength: 50
    },
    developer: {
        type: String,
        trim: true,
        default: '',
        maxlength: 200
    },
    receptionist: {
        type: String,
        trim: true,
        default: '',
        maxlength: 100
    },
    remark: {
        type: String,
        trim: true,
        default: '',
        maxlength: 500
    },
    channel: {
        type: String,
        trim: true,
        default: '',
        maxlength: 100
    },
    senderName: {
        type: String,
        trim: true,
        default: 'Unknown',
        maxlength: 100
    },
    senderId: {
        type: Number,
        default: 0
    },
    rawMessage: {
        type: String,
        default: '',
        maxlength: 5000
    },
    collectionDate: {
        type: String,
        required: true,
        index: true
    },
    collectionMonth: {
        type: String,
        required: true,
        index: true
    },
    source: {
        type: String,
        default: 'telegram',
        enum: ['telegram', 'json_import', 'telegram_import', 'admin']
    },
    importedAt: {
        type: Date
    }
}, {
    timestamps: {
        createdAt: 'collectedAt',
        updatedAt: 'updatedAt'
    }
});

// Indexes for better performance
recordSchema.index({ platformAccount: 1 });
recordSchema.index({ collectionDate: 1, collectionMonth: 1 });
recordSchema.index({ developer: 1 });
recordSchema.index({ receptionist: 1 });
recordSchema.index({ senderName: 1 });
recordSchema.index({ createdAt: -1 });

const Record = mongoose.model('Record', recordSchema);

module.exports = Record;
