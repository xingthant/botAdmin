const mongoose = require('mongoose');

const recordSchema = new mongoose.Schema({
    wsAccount: {
        type: String,
        trim: true,
        default: ''
    },
    platformAccount: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    todayDeposit: {
        type: Number,
        default: 0,
        min: 0
    },
    monthDeposit: {
        type: Number,
        default: 0,
        min: 0
    },
    joinDate: {
        type: String,
        trim: true,
        default: ''
    },
    ipStatus: {
        type: String,
        trim: true,
        default: '正常'
    },
    developer: {
        type: String,
        trim: true,
        default: ''
    },
    receptionist: {
        type: String,
        trim: true,
        default: ''
    },
    remark: {
        type: String,
        trim: true,
        default: ''
    },
    channel: {
        type: String,
        trim: true,
        default: ''
    },
    senderName: {
        type: String,
        trim: true,
        default: 'Unknown'
    },
    senderId: {
        type: Number,
        default: 0
    },
    rawMessage: {
        type: String,
        default: ''
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

// Static method to get daily stats
recordSchema.statics.getDailyStats = async function(date) {
    const result = await this.aggregate([
        { $match: { collectionDate: date } },
        { $group: {
            _id: null,
            count: { $sum: 1 },
            totalTodayDeposit: { $sum: "$todayDeposit" },
            totalMonthDeposit: { $sum: "$monthDeposit" }
        }}
    ]);
    return result[0] || { count: 0, totalTodayDeposit: 0, totalMonthDeposit: 0 };
};

// Static method to get monthly stats
recordSchema.statics.getMonthlyStats = async function(month) {
    const result = await this.aggregate([
        { $match: { collectionMonth: month } },
        { $group: {
            _id: null,
            count: { $sum: 1 },
            totalTodayDeposit: { $sum: "$todayDeposit" },
            totalMonthDeposit: { $sum: "$monthDeposit" }
        }}
    ]);
    return result[0] || { count: 0, totalTodayDeposit: 0, totalMonthDeposit: 0 };
};

// Static method to get developer stats
recordSchema.statics.getDeveloperStats = async function() {
    return await this.aggregate([
        { $match: { developer: { $ne: "" } } },
        { $group: {
            _id: "$developer",
            count: { $sum: 1 },
            totalDeposit: { $sum: "$monthDeposit" }
        }},
        { $sort: { count: -1 } }
    ]);
};

const Record = mongoose.model('Record', recordSchema);

module.exports = Record;
