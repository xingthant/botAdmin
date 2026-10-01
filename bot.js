const fetch = require("node-fetch");
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const Record = require("./models/Record");
const multer = require("multer");

// =========================
// ENVIRONMENT VALIDATION
// =========================
const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID) || 8475328848;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!TOKEN) {
    console.error("❌ BOT_TOKEN is required!");
    process.exit(1);
}
if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI is required!");
    process.exit(1);
}
if (!ADMIN_PASSWORD) {
    console.error("❌ ADMIN_PASSWORD is required!");
    process.exit(1);
}
if (!SESSION_SECRET) {
    console.error("❌ SESSION_SECRET is required!");
    process.exit(1);
}

console.log("✅ Environment variables loaded successfully");
console.log("📀 MongoDB URI:", MONGODB_URI.replace(/\/\/.*@/, '//***:***@'));

// =========================
// STATE
// =========================
let collecting = false;
let records = [];
let accountSet = new Set();
let totalRecords = 0;
let totalTodayDeposit = 0;
let totalMonthDeposit = 0;
let collectionStartTime = null;
let isMongoConnected = false;
let messageQueue = [];
const MAX_QUEUE_SIZE = 10000;
let isProcessingQueue = false;
let importStats = {
    total: 0,
    imported: 0,
    duplicates: 0,
    errors: 0
};

// =========================
// INIT BOT
// =========================
const bot = new TelegramBot(TOKEN, {
    polling: {
        autoStart: false,
        params: {
            timeout: 10
        }
    },
    request: {
        timeout: 30000,
        pool: {
            maxSockets: 1
        }
    }
});

// =========================
// TEXT FLATTENING HELPER
// =========================
// Flattens Telegram's text array (with {type, text} entities) into one string.
function flattenText(text) {
    if (typeof text === 'string') return text;
    if (!Array.isArray(text)) return '';
    return text.map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item && item.text) return item.text;
        return '';
    }).join('');
}

// =========================
// FIELD EXTRACTION HELPER
// =========================
// Extracts the value after a label. Supports separators: : ： ; ； ➤ ⇛ =
// allowSlash=true → allows digits, /, -, . (for dates like 27/6)
function extractField(text, labelRegex, allowSlash = false, allowInternalSpace = false) {
    // Match label, then skip anything that's not a digit, then grab digits
    const labelMatch = text.match(new RegExp(labelRegex.source + String.raw`[^\d]*`, 'i'));
    if (!labelMatch) return null;

    const afterLabel = text.substring(labelMatch.index + labelMatch[0].length);
    let cleaned;

    if (allowInternalSpace) {
        const chunk = afterLabel.substring(0, 30);
        const m = chunk.match(/^[\d\s]+/);
        if (!m) return null;
        cleaned = m[0].replace(/\s+/g, '').substring(0, 13);
    } else if (allowSlash) {
        const chunk = afterLabel.substring(0, 20);
        const m = chunk.match(/^[\d\/\-\.\s]+/);
        if (!m) return null;
        cleaned = m[0].replace(/\s+/g, '').substring(0, 15);
    } else {
        const chunk = afterLabel.substring(0, 20);
        const m = chunk.match(/^\d+/);
        if (!m) return null;
        cleaned = m[0];
    }

    return cleaned.trim() || null;
}

// =========================
// EXTRACT DATA FUNCTION
// =========================
// Only extracts a record if the text contains BOTH "ws账号" AND "进粉日期".
// This filters out backend replies, marketing spam, and random chatter.
function extractData(text) {
    const cleanText = flattenText(text).replace(/\s+/g, ' ').trim();

    if (!/ws\s*账号/i.test(cleanText)) return null;
    if (!/进粉日期/.test(cleanText)) return null;

    const wsAccount       = extractField(cleanText, /ws\s*账号/, false, true);   // ← TRUE
    const platformAccount = extractField(cleanText, /会员账户/, false, true);    // ← TRUE
    const joinDate        = extractField(cleanText, /进粉日期/, true, false);
    const receptionist    = extractField(cleanText, /推送后端/, false, false);

    if (!wsAccount || !platformAccount) {
        console.log('⚠️ Skipped: missing wsAccount or platformAccount');
        return null;
    }

    return {
        wsAccount,
        platformAccount,
        joinDate: joinDate || '',
        receptionist: receptionist || '',
        rawText: cleanText
    };
}

// =========================
// PARSE TELEGRAM EXPORT
// =========================
function parseTelegramExport(jsonData) {
    try {
        let data = jsonData;
        if (typeof jsonData === 'string') {
            data = JSON.parse(jsonData);
        }

        if (!data.messages || !Array.isArray(data.messages)) {
            console.log('❌ No messages array found in JSON');
            return [];
        }

        console.log(`📊 Total messages in file: ${data.messages.length}`);

        const records = [];
        let skippedNonMessage = 0;
        let skippedNoMarker   = 0;
        let skippedIncomplete = 0;

        for (const msg of data.messages) {
            if (msg.type !== 'message') { skippedNonMessage++; continue; }
            if (!msg.text) { skippedNonMessage++; continue; }

            const text = flattenText(msg.text);
            if (!text) { skippedNonMessage++; continue; }

            // ✅ GATE 1: must contain "ws账号"
            if (!/ws\s*账号/i.test(text)) { skippedNoMarker++; continue; }
            // ✅ GATE 2: must contain "进粉日期"
            if (!/进粉日期/.test(text)) { skippedNoMarker++; continue; }

            // Extract only the fields we care about
            const wsAccount       = extractField(text, /ws\s*账号/, false);
            const platformAccount = extractField(text, /会员账户/, false);
            const joinDate        = extractField(text, /进粉日期/, true);
            const receptionist    = extractField(text, /推送后端/, false);

            if (!wsAccount || !platformAccount) { skippedIncomplete++; continue; }

            // Sender name: prefer msg.from, fall back to from_id, then Unknown
            let senderName = 'Unknown';
            if (msg.from && typeof msg.from === 'string' && msg.from.trim()) {
                senderName = msg.from.trim();
            } else if (msg.from_id) {
                senderName = msg.from_id;
            }

            records.push({
                wsAccount,
                platformAccount,
                joinDate: joinDate || '',
                receptionist: receptionist || '',
                senderName,
                rawText: text
            });
        }

        console.log(`✅ Valid lead records: ${records.length}`);
        console.log(`   ⏭️  Skipped non-message: ${skippedNonMessage}`);
        console.log(`   ⏭️  Skipped no ws/进粉 marker: ${skippedNoMarker}`);
        console.log(`   ⏭️  Skipped incomplete fields: ${skippedIncomplete}`);

        if (records.length > 0) {
            console.log('📋 First record sample:', JSON.stringify(records[0], null, 2));
        }

        return records;

    } catch (err) {
        console.error('❌ Error parsing JSON:', err);
        return [];
    }
}

// =========================
// SAVE RECORD WITH RETRY
// =========================
// Returns:
//   true        → saved successfully
//   'duplicate' → already exists in DB
//   false       → failed and backed up locally
async function saveRecordWithRetry(recordData, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (mongoose.connection.readyState !== 1) {
                console.log(`⚠️ MongoDB not ready, attempt ${attempt}/${maxRetries}`);
                await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
                continue;
            }

            const record = new Record(recordData);
            await record.save();
            console.log(`✅ Saved successfully on attempt ${attempt}`);
            return true;
        } catch (err) {
            console.log(`❌ Save attempt ${attempt} failed:`, err.message);

            if (err.code === 11000) {
                console.log(`⚠️ Record already exists in DB`);
                return 'duplicate';
            }

            if (attempt === maxRetries) {
                console.error('❌ All save attempts failed, backing up locally');
                saveToLocalBackup(recordData);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
    return false;
}

// =========================
// LOCAL BACKUP
// =========================
function saveToLocalBackup(data) {
    try {
        const backupFile = path.join(__dirname, 'backup.json');
        let backups = [];
        if (fs.existsSync(backupFile)) {
            backups = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
        }
        backups.push({
            timestamp: new Date().toISOString(),
            data: data
        });
        if (backups.length > 1000) {
            backups = backups.slice(-1000);
        }
        fs.writeFileSync(backupFile, JSON.stringify(backups, null, 2));
        console.log(`💾 Saved to local backup (${backups.length} total backups)`);
    } catch (err) {
        console.error('❌ Failed to save local backup:', err);
    }
}

// =========================
// PROCESS MESSAGE (LIVE BOT)
// =========================
async function processMessage(msg) {
    if (!collecting) return;
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;

    if (mongoose.connection.readyState !== 1) {
        console.log("📥 Queuing message (MongoDB not ready)");
        messageQueue.push(msg);
        if (messageQueue.length > MAX_QUEUE_SIZE) {
            console.warn(`⚠️ messageQueue exceeded ${MAX_QUEUE_SIZE}, dropping oldest`);
            messageQueue.shift();
        }
        return;
    }

    const text = flattenText(msg.text).trim();

    // extractData returns null if the message isn't a real lead post
    const data = extractData(text);
    if (!data) {
        console.log('⏭️ Not a lead post, skipping');
        return;
    }

    if (accountSet.has(data.platformAccount)) {
        console.log(`⏭️ Duplicate: ${data.platformAccount}`);
        return;
    }

    const senderName = msg.from && msg.from.username
        ? `@${msg.from.username}`
        : (msg.from && msg.from.first_name)
            ? `${msg.from.first_name}`
            : 'Unknown';

    try {
        const now = new Date();
        const collectionDate  = now.toISOString().split('T')[0];
        const collectionMonth = collectionDate.substring(0, 7);

        const recordData = {
            wsAccount:        data.wsAccount,
            platformAccount:  data.platformAccount,
            todayDeposit:     0,
            monthDeposit:     0,
            joinDate:         data.joinDate || '',
            ipStatus:         '正常',
            developer:        '',
            receptionist:     data.receptionist || '',
            remark:           '',
            channel:          '',
            senderName:       senderName,
            senderId:         (msg.from && msg.from.id) ? msg.from.id : 0,
            rawMessage:       text,
            collectionDate:   collectionDate,
            collectionMonth:  collectionMonth
        };

        const saved = await saveRecordWithRetry(recordData);
        if (saved === true) {
            accountSet.add(data.platformAccount);
            totalRecords++;
            console.log(`✅ Saved: ${data.platformAccount}`);
        } else if (saved === 'duplicate') {
            accountSet.add(data.platformAccount);
            console.log(`⏭️ Duplicate in DB: ${data.platformAccount}`);
        } else {
            console.log(`⚠️ Failed to save: ${data.platformAccount} (backed up locally)`);
        }
    } catch (err) {
        console.error('❌ Error processing message:', err);
    }
}

// =========================
// PROCESS QUEUE
// =========================
async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;

    isProcessingQueue = true;
    console.log(`📤 Processing ${messageQueue.length} queued messages`);

    while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        await processMessage(msg);
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    isProcessingQueue = false;
    console.log('✅ Queue processing complete');
}

// =========================
// LOAD EXISTING ACCOUNTS
// =========================
async function loadExistingAccounts() {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const accounts = await Record.find({}, 'platformAccount');
        accountSet.clear();
        accounts.forEach(record => {
            if (record.platformAccount) {
                accountSet.add(record.platformAccount);
            }
        });
        console.log(`✅ Loaded ${accountSet.size} existing accounts`);
    } catch (err) {
        console.error('Error loading existing accounts:', err);
    }
}

// =========================
// CONNECT TO MONGODB
// =========================
async function connectMongoDB() {
    try {
        console.log('📀 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 30000,
        });
        isMongoConnected = true;
        console.log("✅ Connected to MongoDB");
        await loadExistingAccounts();
        await processQueue();
        return true;
    } catch (err) {
        console.error("❌ MongoDB Connection Error:", err.message);
        isMongoConnected = false;
        return false;
    }
}

// =========================
// MONGODB EVENT HANDLERS
// =========================
mongoose.connection.on('connected', async () => {
    console.log('✅ MongoDB connected');
    isMongoConnected = true;
    await loadExistingAccounts();
    await processQueue();
});

mongoose.connection.on('disconnected', () => {
    console.log('❌ MongoDB disconnected');
    isMongoConnected = false;
});

mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB error:', err);
    isMongoConnected = false;
});

mongoose.connection.on('reconnected', async () => {
    console.log('✅ MongoDB reconnected');
    isMongoConnected = true;
    await loadExistingAccounts();
    await processQueue();
});

// =========================
// EXPRESS APP
// =========================
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    name: 'telegram_bot_session'
}));

// =========================
// AUTHENTICATION
// =========================
function isAuthenticated(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}

// =========================
// HEALTH CHECK
// =========================
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        mongoState: mongoose.connection.readyState,
        collecting: collecting,
        records: accountSet.size,
        queued: messageQueue.length
    });
});

// =========================
// LOGIN ROUTES
// =========================
app.get('/login', (req, res) => {
    if (req.session) {
        req.session.isAdmin = false;
    }
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    const trimmedPassword = password ? password.trim() : '';
    const trimmedAdminPassword = ADMIN_PASSWORD ? ADMIN_PASSWORD.trim() : '';

    if (trimmedPassword === trimmedAdminPassword) {
        req.session.isAdmin = true;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.render('login', { error: 'Session error, please try again' });
            }
            res.redirect('/dashboard');
        });
    } else {
        res.render('login', { error: 'Invalid password' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/login');
    });
});

// =========================
// DASHBOARD
// =========================
app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = today.substring(0, 7);

        let total = 0, unique = 0, todayCount = 0, monthCount = 0, todaySum = 0, monthSum = 0;
        let recentRecords = [];
        let stats = {};

        if (mongoose.connection.readyState === 1) {
            total = await Record.countDocuments();
            unique = await Record.distinct('platformAccount').then(arr => arr.length);
            todayCount = await Record.countDocuments({ collectionDate: today });
            monthCount = await Record.countDocuments({ collectionMonth: currentMonth });

            const todayResult = await Record.aggregate([
                { $match: { collectionDate: today } },
                { $group: { _id: null, total: { $sum: "$todayDeposit" } } }
            ]);
            todaySum = todayResult[0]?.total || 0;

            const monthResult = await Record.aggregate([
                { $match: { collectionMonth: currentMonth } },
                { $group: { _id: null, total: { $sum: "$monthDeposit" } } }
            ]);
            monthSum = monthResult[0]?.total || 0;

            stats = await Record.aggregate([
                { $group: {
                    _id: { $ifNull: ["$source", "telegram"] },
                    count: { $sum: 1 }
                }}
            ]);

            recentRecords = await Record.find()
                .sort({ collectedAt: -1 })
                .limit(10);
        }

        res.render('dashboard', {
            status: collecting ? 'active' : 'stopped',
            totalRecords: total,
            uniqueAccounts: unique,
            todayRecords: todayCount,
            todayDeposit: todaySum,
            monthRecords: monthCount,
            monthDeposit: monthSum,
            recentRecords: recentRecords,
            collectionStartTime: collectionStartTime,
            mongoConnected: mongoose.connection.readyState === 1,
            queuedMessages: messageQueue.length,
            stats: stats,
            importStats: importStats
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Error loading dashboard');
    }
});

app.get('/records', isAuthenticated, (req, res) => {
    res.render('records');
});

app.get('/import', isAuthenticated, (req, res) => {
    res.render('import', {
        success: null,
        error: null,
        stats: null,
        preview: null
    });
});

app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// =========================
// IMPORT ROUTES
// =========================
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 200 * 1024 * 1024 }
});

app.post('/api/import/json', isAuthenticated, upload.single('jsonFile'), async (req, res) => {
    try {
        let jsonData;

        if (req.file) {
            const fileContent = fs.readFileSync(req.file.path, 'utf-8');
            jsonData = JSON.parse(fileContent);
            fs.unlinkSync(req.file.path);
        } else if (req.body.jsonData) {
            jsonData = JSON.parse(req.body.jsonData);
        } else {
            return res.status(400).json({ error: 'No JSON data provided' });
        }

        const records = parseTelegramExport(jsonData);
        if (!records || records.length === 0) {
            return res.status(400).json({ error: 'No valid records found in JSON' });
        }

        const preview = records.slice(0, 5);

        res.json({
            success: true,
            total: records.length,
            preview: records.slice(0, 5),   // for the preview table (5 rows)
            records: records,               // ← FULL payload for confirm step
            message: `Found ${records.length} records. Click confirm to import.`
        });

    } catch (err) {
        console.error('Import preview error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/import/confirm', isAuthenticated, async (req, res) => {
    try {
        const { records } = req.body;
        if (!records || !Array.isArray(records) || records.length === 0) {
            return res.status(400).json({ error: 'No records to import' });
        }

        const result = await bulkImportRecords(records, 'json_import');

        importStats = {
            total: result.total,
            imported: result.imported,
            duplicates: result.duplicates,
            errors: result.errors
        };

        res.json({
            success: true,
            stats: result,
            message: `Import complete: ${result.imported} imported, ${result.duplicates} duplicates, ${result.errors} errors`
        });

    } catch (err) {
        console.error('Import confirm error:', err);
        res.status(500).json({ error: err.message });
    }
});

// =========================
// BULK IMPORT FUNCTION
// =========================
async function bulkImportRecords(recordsData, source = 'telegram_import') {
    if (!Array.isArray(recordsData) || recordsData.length === 0) {
        return { imported: 0, duplicates: 0, errors: 0, total: 0 };
    }

    if (mongoose.connection.readyState !== 1) {
        console.log("❌ MongoDB not ready for bulk import");
        return { imported: 0, duplicates: 0, errors: recordsData.length, total: recordsData.length };
    }

    const now = new Date();
    const collectionDate  = now.toISOString().split('T')[0];
    const collectionMonth = collectionDate.substring(0, 7);

    // Build docs in memory
    const docs = [];
    let errors = 0;

    for (const data of recordsData) {
        if (!data.platformAccount || !data.wsAccount) {
            errors++;
            continue;
        }
        docs.push({
            wsAccount:        data.wsAccount,
            platformAccount:  data.platformAccount,
            todayDeposit:     0,
            monthDeposit:     0,
            joinDate:         data.joinDate || '',
            ipStatus:         '正常',
            developer:        '',
            receptionist:     data.receptionist || '',
            remark:           '',
            channel:          '',
            senderName:       data.senderName || 'System Import',
            senderId:         0,
            rawMessage:       data.rawText || JSON.stringify(data),
            collectionDate:   collectionDate,
            collectionMonth:  collectionMonth,
            source:           source,
            importedAt:       now
        });
    }

    let imported   = 0;
    let duplicates = 0;

    // Insert with ordered:false so one duplicate doesn't stop the batch
    const batchSize = 100;
    for (let i = 0; i < docs.length; i += batchSize) {
        const batch = docs.slice(i, i + batchSize);
        try {
            const result = await Record.insertMany(batch, { ordered: false });
            imported += result.length;
            result.forEach(r => { if (r.platformAccount) accountSet.add(r.platformAccount); });
        } catch (err) {
            const writeErrors = (err && err.writeErrors) ? err.writeErrors : [];
            const dupCount = writeErrors.filter(e => e.code === 11000).length;
            const otherErrors = writeErrors.length - dupCount;

            duplicates += dupCount;
            errors     += otherErrors;

            const insertedDocs = (err && err.result && err.result.insertedDocs) ? err.result.insertedDocs : [];
            imported += insertedDocs.length;
            insertedDocs.forEach(r => { if (r.platformAccount) accountSet.add(r.platformAccount); });

            if (!err.writeErrors) {
                console.error('Batch import error:', err);
                errors += batch.length;
            }
        }
    }

    console.log(`📊 Bulk import: total=${recordsData.length}, imported=${imported}, dup=${duplicates}, errors=${errors}`);
    return { imported, duplicates, errors, total: recordsData.length };
}

// =========================
// API ROUTES
// =========================

// GET stats
app.get('/api/stats', isAuthenticated, async (req, res) => {
    try {
        const total = mongoose.connection.readyState === 1 ? await Record.countDocuments() : 0;
        const unique = mongoose.connection.readyState === 1 ? await Record.distinct('platformAccount').then(arr => arr.length) : 0;
        const today = new Date().toISOString().split('T')[0];
        const todayCount = mongoose.connection.readyState === 1 ? await Record.countDocuments({ collectionDate: today }) : 0;

        res.json({
            totalRecords: total,
            uniqueAccounts: unique,
            todayRecords: todayCount,
            collecting: collecting,
            status: collecting ? 'active' : 'stopped',
            mongoConnected: mongoose.connection.readyState === 1,
            queuedMessages: messageQueue.length,
            importStats: importStats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle collection
app.post('/api/toggle', isAuthenticated, async (req, res) => {
    try {
        if (collecting) {
            collecting = false;
            collectionStartTime = null;
            res.json({ status: 'stopped', message: 'Collection stopped' });
        } else {
            collecting = true;
            records = [];
            totalRecords = 0;
            totalTodayDeposit = 0;
            totalMonthDeposit = 0;
            collectionStartTime = new Date();
            res.json({ status: 'active', message: 'Collection started' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET records with pagination
// GET records with pagination
app.get('/api/records', isAuthenticated, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const skip = (page - 1) * limit;
        const sortField = req.query.sort || 'collectedAt';
        const sortOrder = req.query.order === 'asc' ? 1 : -1;

        console.log(`📥 /api/records: page=${page}, limit=${limit}, skip=${skip}, sort=${sortField} ${sortOrder > 0 ? 'ASC' : 'DESC'}`);

        if (mongoose.connection.readyState !== 1) {
            console.log('  ⚠️ MongoDB not connected');
            return res.json({ records: [], total: 0, page: 1, totalPages: 0 });
        }

        const sortObj = {};
        sortObj[sortField] = sortOrder;
        sortObj['_id'] = 1;   // ✅ stable tiebreaker (prevents unstable pagination)

        const records = await Record.find()
            .sort(sortObj)
            .skip(skip)
            .limit(limit)
            .allowDiskUse(true);   // ✅ prevents 32 MB sort memory error

        const total = await Record.countDocuments();

        console.log(`  ✅ Returned ${records.length} records (skip ${skip})`);

        res.json({
            records,
            total,
            page,
            totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('  ❌ /api/records error:', err);
        res.status(500).json({ error: err.message });
    }
});

// SEARCH records
app.get('/api/search', isAuthenticated, async (req, res) => {
    try {
        const query = req.query.q;
        const field = req.query.field || 'all';

        if (!query || mongoose.connection.readyState !== 1) {
            return res.json({ records: [] });
        }

        let searchQuery = {};

        if (field === 'all') {
            searchQuery = {
                $or: [
                    { platformAccount: { $regex: query, $options: 'i' } },
                    { wsAccount: { $regex: query, $options: 'i' } },
                    { senderName: { $regex: query, $options: 'i' } },
                    { receptionist: { $regex: query, $options: 'i' } },
                    { developer: { $regex: query, $options: 'i' } },
                    { rawMessage: { $regex: query, $options: 'i' } },
                    { remark: { $regex: query, $options: 'i' } },
                    { channel: { $regex: query, $options: 'i' } }
                ]
            };
        } else {
            searchQuery = { [field]: { $regex: query, $options: 'i' } };
        }

        const records = await Record.find(searchQuery)
            .limit(100)
            .allowDiskUse(true);
        res.json({ records });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================
// CRUD OPERATIONS
// =========================

// CREATE new record
app.post('/api/records', isAuthenticated, async (req, res) => {
    try {
        console.log('📝 Adding new record...');
        console.log('Request body:', req.body);

        if (mongoose.connection.readyState !== 1) {
            console.error('❌ MongoDB not connected. State:', mongoose.connection.readyState);
            return res.status(503).json({
                error: 'MongoDB is not connected',
                readyState: mongoose.connection.readyState
            });
        }

        const {
            wsAccount,
            platformAccount,
            todayDeposit,
            monthDeposit,
            joinDate,
            ipStatus,
            developer,
            receptionist,
            remark,
            channel,
            senderName,
            rawMessage
        } = req.body;

        if (!platformAccount) {
            return res.status(400).json({ error: 'Platform account is required' });
        }

        const cleanPlatformAccount = platformAccount.toString().trim();

        const existing = await Record.findOne({ platformAccount: cleanPlatformAccount });
        if (existing) {
            return res.status(400).json({
                error: `Platform account ${cleanPlatformAccount} already exists`
            });
        }

        const now = new Date();
        const collectionDate = now.toISOString().split('T')[0];
        const collectionMonth = collectionDate.substring(0, 7);

        const recordData = {
            wsAccount: wsAccount ? wsAccount.toString().trim() : '',
            platformAccount: cleanPlatformAccount,
            todayDeposit: parseInt(todayDeposit) || 0,
            monthDeposit: parseInt(monthDeposit) || 0,
            joinDate: joinDate ? joinDate.toString().trim() : '',
            ipStatus: ipStatus || '正常',
            developer: developer ? developer.toString().trim() : '',
            receptionist: receptionist ? receptionist.toString().trim() : '',
            remark: remark ? remark.toString().trim() : '',
            channel: channel ? channel.toString().trim() : '',
            senderName: senderName || 'Admin',
            senderId: 0,
            rawMessage: rawMessage || `Manual entry: ${cleanPlatformAccount}`,
            collectionDate: collectionDate,
            collectionMonth: collectionMonth
        };

        const record = new Record(recordData);
        await record.save();

        accountSet.add(cleanPlatformAccount);

        console.log('✅ Record saved successfully:', record._id);

        res.json({
            success: true,
            message: 'Record added successfully',
            record: record
        });

    } catch (err) {
        console.error('❌ Error adding record:', err);

        if (err.code === 11000) {
            return res.status(400).json({
                error: 'Duplicate key error. This platform account already exists.'
            });
        }

        if (err.name === 'ValidationError') {
            return res.status(400).json({
                error: 'Validation error',
                details: err.message
            });
        }

        res.status(500).json({
            error: err.message || 'Failed to add record'
        });
    }
});

// GET single record
app.get('/api/records/:id', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }
        const record = await Record.findById(req.params.id);
        if (!record) {
            return res.status(404).json({ error: 'Record not found' });
        }
        res.json(record);
    } catch (err) {
        console.error('Error fetching record:', err);
        res.status(500).json({ error: err.message });
    }
});

// UPDATE record
app.put('/api/records/:id', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }

        const {
            wsAccount,
            platformAccount,
            todayDeposit,
            monthDeposit,
            joinDate,
            ipStatus,
            developer,
            receptionist,
            remark,
            channel,
            senderName,
            rawMessage
        } = req.body;

        if (!platformAccount) {
            return res.status(400).json({ error: 'Platform account is required' });
        }

        const record = await Record.findById(req.params.id);
        if (!record) {
            return res.status(404).json({ error: 'Record not found' });
        }

        if (record.platformAccount !== platformAccount.toString().trim()) {
            const existing = await Record.findOne({ platformAccount: platformAccount.toString().trim() });
            if (existing) {
                return res.status(400).json({ error: 'Platform account already exists in another record' });
            }
            accountSet.delete(record.platformAccount);
            accountSet.add(platformAccount.toString().trim());
        }

        record.wsAccount = wsAccount || '';
        record.platformAccount = platformAccount.toString().trim();
        record.todayDeposit = parseInt(todayDeposit) || 0;
        record.monthDeposit = parseInt(monthDeposit) || 0;
        record.joinDate = joinDate || '';
        record.ipStatus = ipStatus || '正常';
        record.developer = developer || '';
        record.receptionist = receptionist || '';
        record.remark = remark || '';
        record.channel = channel || '';
        record.senderName = senderName || 'Admin';
        record.rawMessage = rawMessage || record.rawMessage;

        await record.save();

        res.json({ success: true, message: 'Record updated successfully', record });
    } catch (err) {
        console.error('Error updating record:', err);
        if (err.code === 11000) {
            return res.status(400).json({ error: 'Duplicate platform account' });
        }
        res.status(500).json({ error: err.message });
    }
});

// DELETE record
app.delete('/api/records/:id', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }

        const deleted = await Record.findByIdAndDelete(req.params.id);
        if (deleted) {
            const exists = await Record.findOne({ platformAccount: deleted.platformAccount });
            if (!exists) {
                accountSet.delete(deleted.platformAccount);
            }
            res.json({ success: true, message: 'Record deleted successfully' });
        } else {
            res.status(404).json({ error: 'Record not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================
// EXPORT ROUTES
// =========================

// EXPORT CSV
app.get('/api/export/csv', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }

        let query = {};
        if (req.query.q) {
            const searchQuery = req.query.q;
            const field = req.query.field || 'all';
            if (field === 'all') {
                query = {
                    $or: [
                        { platformAccount: { $regex: searchQuery, $options: 'i' } },
                        { wsAccount: { $regex: searchQuery, $options: 'i' } },
                        { senderName: { $regex: searchQuery, $options: 'i' } },
                        { receptionist: { $regex: searchQuery, $options: 'i' } },
                        { developer: { $regex: searchQuery, $options: 'i' } }
                    ]
                };
            } else {
                query = { [field]: { $regex: searchQuery, $options: 'i' } };
            }
        }

        const records = await Record.find(query)
            .sort({ collectedAt: -1, _id: 1 })
            .allowDiskUse(true);

        let csv = "Platform Account,WS Account,T Deposit,M Deposit,Join Date,IP Status,Developer,Receptionist,Sender,Date,Message\n";
        records.forEach(r => {
            const message = (r.rawMessage || '').replace(/"/g, '""');
            csv += `${r.platformAccount || ''},${r.wsAccount || ''},${r.todayDeposit || 0},${r.monthDeposit || 0},${r.joinDate || ''},${r.ipStatus || ''},${r.developer || ''},${r.receptionist || ''},${r.senderName || ''},${r.collectedAt || ''},"${message}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=export_${Date.now()}.csv`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// EXPORT JSON
app.get('/api/export/json', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }

        let query = {};
        if (req.query.q) {
            const searchQuery = req.query.q;
            const field = req.query.field || 'all';
            if (field === 'all') {
                query = {
                    $or: [
                        { platformAccount: { $regex: searchQuery, $options: 'i' } },
                        { wsAccount: { $regex: searchQuery, $options: 'i' } },
                        { senderName: { $regex: searchQuery, $options: 'i' } },
                        { receptionist: { $regex: searchQuery, $options: 'i' } },
                        { developer: { $regex: searchQuery, $options: 'i' } }
                    ]
                };
            } else {
                query = { [field]: { $regex: searchQuery, $options: 'i' } };
            }
        }

        const records = await Record.find(query)
            .sort({ collectedAt: -1, _id: 1 })
            .allowDiskUse(true);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=export_${Date.now()}.json`);
        res.json(records);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Alias: /api/export → CSV (for backwards compatibility with dashboard)
app.get('/api/export', isAuthenticated, async (req, res) => {
    res.redirect('/api/export/csv');
});

// =========================
// CLEAR ALL DATA
// =========================
app.post('/api/clear', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }

        await Record.deleteMany({});
        accountSet.clear();
        records = [];
        totalRecords = 0;
        totalTodayDeposit = 0;
        totalMonthDeposit = 0;
        res.json({ success: true, message: 'All data cleared successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================
// DATABASE STATUS ENDPOINT
// =========================
app.get('/api/db-status', isAuthenticated, (req, res) => {
    const stateMap = {
        0: 'disconnected',
        1: 'connected',
        2: 'connecting',
        3: 'disconnecting'
    };
    res.json({
        readyState: mongoose.connection.readyState,
        status: stateMap[mongoose.connection.readyState] || 'unknown',
        host: mongoose.connection.host || 'N/A',
        name: mongoose.connection.name || 'N/A',
        isMongoConnected: isMongoConnected,
        accountSetSize: accountSet.size,
        queuedMessages: messageQueue.length
    });
});

// =========================
// START EXPRESS SERVER
// =========================
function startExpressServer() {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Admin panel running on port ${PORT}`);
        console.log(`🔗 Health check: http://localhost:${PORT}/health`);
        console.log(`🔗 DB Status: http://localhost:${PORT}/api/db-status`);
    });
}

// =========================
// START BOT
// =========================
async function startBot() {
    try {
        await connectMongoDB();
        try {
            bot.stopPolling();
        } catch (e) {}
        setTimeout(() => {
            bot.startPolling();
            console.log("🤖 Bot polling started");
        }, 2000);
        startExpressServer();

        setInterval(processQueue, 10000);
    } catch (err) {
        console.error("❌ Failed to start bot:", err);
        setTimeout(() => {
            bot.startPolling();
            console.log("🤖 Bot started without MongoDB");
        }, 2000);
        startExpressServer();
    }
}

// =========================
// TELEGRAM COMMANDS
// =========================
bot.onText(/\/startcollect/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    collecting = true;
    records = [];
    totalRecords = 0;
    totalTodayDeposit = 0;
    totalMonthDeposit = 0;
    collectionStartTime = new Date();
    bot.sendMessage(msg.chat.id, "🚀 Collection Started!");
});

bot.onText(/\/summary/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    try {
        if (mongoose.connection.readyState !== 1) {
            return bot.sendMessage(msg.chat.id, "❌ MongoDB is not connected");
        }
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = today.substring(0, 7);
        const todayCount = await Record.countDocuments({ collectionDate: today });
        const monthCount = await Record.countDocuments({ collectionMonth: currentMonth });
        const totalCount = await Record.countDocuments();
        const status = collecting ? "🟢 Active" : "🔴 Stopped";
        bot.sendMessage(msg.chat.id,
            `📊 Summary\n\nStatus: ${status}\nToday Records: ${todayCount}\nMonth Records: ${monthCount}\nTotal Records: ${totalCount}\nQueued: ${messageQueue.length}\nUnique Accounts: ${accountSet.size}`
        );
    } catch (err) {
        console.error('Error getting summary:', err);
        bot.sendMessage(msg.chat.id, "❌ Error getting summary");
    }
});

bot.onText(/\/stopcollect/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    collecting = false;
    collectionStartTime = null;
    bot.sendMessage(msg.chat.id, "✅ Collection Stopped");
});

bot.onText(/\/status/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    const status = collecting ? "🟢 Active" : "🔴 Stopped";
    const total = mongoose.connection.readyState === 1 ? await Record.countDocuments() : 0;
    const mongoStatus = mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected';
    bot.sendMessage(msg.chat.id,
        `🤖 Bot Status\n\nStatus: ${status}\nMongoDB: ${mongoStatus}\nTotal Records: ${total}\nUnique Accounts: ${accountSet.size}\nQueued: ${messageQueue.length}`
    );
});

bot.onText(/\/test/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    const testMessages = [
        "席位                 ➤         君恒💸\nws账号            ➤      5217205745325\n会员账户         ➤       7205745325\n进粉日期         ➤      27/6\n推送后端         ➤      令煜\n当天总引飞     ➤      4"
    ];
    for (const testMsg of testMessages) {
        const data = extractData(testMsg);
        if (!data) {
            await bot.sendMessage(msg.chat.id, "⚠️ extractData returned null — not a valid lead post");
            continue;
        }
        await bot.sendMessage(msg.chat.id,
            `📝 Test Extraction:\nwsAccount: ${data.wsAccount}\nplatformAccount: ${data.platformAccount}\njoinDate: ${data.joinDate}\nreceptionist: ${data.receptionist}`
        );
    }
});

bot.onText(/\/import/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    bot.sendMessage(msg.chat.id,
        `📥 JSON Import Instructions\n\n` +
        `Send me a JSON file exported from Telegram.\n\n` +
        `The bot will extract only messages containing "ws账号" AND "进粉日期".\n\n` +
        `Type /confirm_import after sending the file to import.`
    );
});

// =========================
// HANDLE DOCUMENT (JSON FILE) UPLOADS
// =========================
bot.on("document", async (msg) => {
    if (msg.from.id !== OWNER_ID) {
        return bot.sendMessage(msg.chat.id, "❌ You are not authorized to import data.");
    }

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || 'unknown.json';
    const fileSize = msg.document.file_size || 0;

    if (!fileName.endsWith('.json') && !fileName.endsWith('.JSON')) {
        return bot.sendMessage(msg.chat.id, "❌ Please send a JSON file (.json)");
    }

    if (fileSize > 10 * 1024 * 1024) {
        return bot.sendMessage(msg.chat.id, "❌ File too large. Maximum size is 10MB.");
    }

    try {
        const processingMsg = await bot.sendMessage(msg.chat.id, "⏳ Processing JSON file... Please wait.");

        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

        const response = await fetch(fileUrl);
        if (!response.ok) {
            throw new Error(`Failed to download file: ${response.status}`);
        }

        const jsonText = await response.text();

        let jsonData;
        try {
            jsonData = JSON.parse(jsonText);
        } catch (parseErr) {
            await bot.deleteMessage(msg.chat.id, processingMsg.message_id);
            return bot.sendMessage(msg.chat.id, "❌ Invalid JSON format. Please check the file content.");
        }

        const records = parseTelegramExport(jsonData);
        if (!records || records.length === 0) {
            await bot.deleteMessage(msg.chat.id, processingMsg.message_id);
            return bot.sendMessage(msg.chat.id, "❌ No valid records found in the JSON file. Please check the format.");
        }

        await bot.deleteMessage(msg.chat.id, processingMsg.message_id);

        let summary = `📄 File Analysis Complete\n\n`;
        summary += `📊 Found ${records.length} valid lead records.\n\n`;
        summary += `📋 Preview (first 5 records):\n`;
        summary += `─────────────────────\n`;

        const maxPreview = Math.min(records.length, 5);
        for (let i = 0; i < maxPreview; i++) {
            const r = records[i];
            summary += `${i + 1}. WS: ${r.wsAccount || 'N/A'}, `;
            summary += `Account: ${r.platformAccount || 'N/A'}, `;
            summary += `Join: ${r.joinDate || 'N/A'}\n`;
        }

        if (records.length > 5) {
            summary += `... and ${records.length - 5} more records\n`;
        }

        summary += `─────────────────────\n\n`;
        summary += `⚠️ This will check for duplicates and only import new records.\n\n`;
        summary += `Type /confirm_import to import all records, or /cancel to cancel.`;

        await bot.sendMessage(msg.chat.id, summary);

        global._pendingImport = {
            records: records,
            chatId: msg.chat.id,
            timestamp: Date.now(),
            fileName: fileName,
            fileSize: fileSize
        };

        setTimeout(() => {
            if (global._pendingImport && global._pendingImport.chatId === msg.chat.id) {
                global._pendingImport = null;
                bot.sendMessage(msg.chat.id, "⏰ Import session expired. Please send the file again.");
            }
        }, 5 * 60 * 1000);

    } catch (err) {
        console.error('Document processing error:', err);
        bot.sendMessage(msg.chat.id, `❌ Error processing file: ${err.message}`);
    }
});

// =========================
// CONFIRM IMPORT COMMAND
// =========================
bot.onText(/\/confirm_import/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;

    if (!global._pendingImport || global._pendingImport.chatId !== msg.chat.id) {
        return bot.sendMessage(msg.chat.id, "❌ No pending import found. Send a JSON file first.");
    }

    if (Date.now() - global._pendingImport.timestamp > 5 * 60 * 1000) {
        global._pendingImport = null;
        return bot.sendMessage(msg.chat.id, "⏰ Import session expired. Please send the file again.");
    }

    const records = global._pendingImport.records;
    const fileName = global._pendingImport.fileName;
    const totalRecords = records.length;

    const processingMsg = await bot.sendMessage(msg.chat.id, `⏳ Importing ${totalRecords} records from ${fileName}... Please wait.`);

    try {
        if (mongoose.connection.readyState !== 1) {
            await bot.deleteMessage(msg.chat.id, processingMsg.message_id);
            return bot.sendMessage(msg.chat.id, "❌ MongoDB is not connected. Please check the database.");
        }

        // Use the shared bulk import helper
        const result = await bulkImportRecords(records, 'telegram_import');
        const imported   = result.imported;
        const duplicates = result.duplicates;
        const errors     = result.errors;

        importStats = {
            total:      result.total,
            imported:   result.imported,
            duplicates: result.duplicates,
            errors:     result.errors
        };

        // Final progress edit
        try {
            await bot.editMessageText(
                `⏳ Import complete: ✅ ${imported} imported | ⚠️ ${duplicates} duplicates | ❌ ${errors} errors`,
                { chat_id: msg.chat.id, message_id: processingMsg.message_id }
            );
        } catch (editErr) {
            console.log('Edit message error:', editErr.message);
        }

        const totalRecordsCount = await Record.countDocuments();
        const uniqueAccounts = accountSet.size;

        let statusMsg = `✅ IMPORT COMPLETE!\n\n`;
        statusMsg += `📊 Summary\n`;
        statusMsg += `├─ Total Records: ${totalRecords}\n`;
        statusMsg += `├─ ✅ Imported: ${imported}\n`;
        statusMsg += `├─ ⚠️ Duplicates: ${duplicates}\n`;
        statusMsg += `└─ ❌ Errors: ${errors}\n\n`;

        statusMsg += `📈 Updated Totals\n`;
        statusMsg += `├─ Total Records: ${totalRecordsCount}\n`;
        statusMsg += `└─ Unique Accounts: ${uniqueAccounts}\n\n`;
        statusMsg += `Type /summary to see detailed statistics.`;

        await bot.deleteMessage(msg.chat.id, processingMsg.message_id);
        await bot.sendMessage(msg.chat.id, statusMsg);

        global._pendingImport = null;

    } catch (err) {
        console.error('Import error:', err);
        await bot.deleteMessage(msg.chat.id, processingMsg.message_id);
        bot.sendMessage(msg.chat.id, `❌ Import failed: ${err.message}`);
        global._pendingImport = null;
    }
});

// =========================
// CANCEL IMPORT COMMAND
// =========================
bot.onText(/\/cancel/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    if (global._pendingImport) {
        global._pendingImport = null;
        bot.sendMessage(msg.chat.id, "✅ Import cancelled");
    } else {
        bot.sendMessage(msg.chat.id, "ℹ️ No pending import to cancel");
    }
});

// =========================
// MESSAGE HANDLER
// =========================
bot.on("message", async (msg) => {
    if (!collecting) return;
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;

    await processMessage(msg);
});

// =========================
// ERROR HANDLING
// =========================
bot.on("polling_error", (err) => {
    console.error("========== POLLING ERROR ==========");
    console.error(err);
    console.error("Code:", err.code);
    console.error("Message:", err.message);

    if (err.response) {
        console.error("Status:", err.response.statusCode);
        console.error("Body:", err.response.body);
    }

    console.error("==================================");
});

bot.on("error", (err) => {
    console.log("❌ Bot error:", err);
});

// =========================
// START APPLICATION
// =========================
console.log("🤖 Bot starting...");
startBot();
console.log("🚀 Bot initialization complete");

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, closing connections...');
    mongoose.connection.close();
    bot.stopPolling();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});