require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const Record = require("./models/Record");
const multer = require("multer");
const crypto = require("crypto");

// =========================
// ENVIRONMENT VALIDATION
// =========================
const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID) || 7756391343;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim())) : [];

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

console.log("✅ Environment variables loaded successfully");

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
            timeout: 30
        }
    }
});

// =========================
// EXTRACT DATA FUNCTION (Enhanced)
// =========================
function extractData(text) {
    console.log('🔍 Processing text...');
    
    // Clean up text - remove extra spaces and normalize
    const cleanText = text.replace(/\s+/g, ' ').trim();
    
    // Extract WS Account
    const wsMatch = cleanText.match(/(?:Ws账号|WS账号|ws账号|WS帐号|ws帐号)[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    const wsAccount = wsMatch ? wsMatch[1].trim() : null;
    
    // Extract Platform Account
    const accountMatch = cleanText.match(/(?:平台账号|会员账户|会员账号|平台帐号|会员帐号)[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    let platformAccount = accountMatch ? accountMatch[1].trim() : null;
    
    // If no platform account found, try to find any 10-13 digit number that's not the WS account
    if (!platformAccount) {
        const allNumbers = cleanText.match(/\b(\d{10,13})\b/g);
        if (allNumbers) {
            for (const num of allNumbers) {
                if (num !== wsAccount) {
                    platformAccount = num;
                    break;
                }
            }
            if (!platformAccount && allNumbers.length > 0) {
                platformAccount = allNumbers[0];
            }
        }
    }
    
    // Extract Join Date
    const dateMatch = cleanText.match(/(?:进粉日期|粉日期|日期|进粉)[\s\u3000]*[：:；;][\s\u3000]*([^\s\n]+)/i);
    const joinDate = dateMatch ? dateMatch[1].trim() : '';
    
    // Extract IP Status
    const ipMatch = cleanText.match(/(?:IP状态|IP)[\s\u3000]*[：:；;][\s\u3000]*([^\s\n]+)/i);
    const ipStatus = ipMatch ? ipMatch[1].trim() : '正常';
    
    // Extract Developer - Enhanced to handle multiple developers
    const devMatch = cleanText.match(/(?:开发|开发者)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/i);
    let developer = devMatch ? devMatch[1].trim() : '';
    if (developer) {
        // Clean up developer field
        developer = developer.replace(/\s*\/\/\/\/\/\s*/g, ' // ');
        developer = developer.replace(/\s*\/\s*/g, ' / ');
        developer = developer.replace(/\s{2,}/g, ' ');
        developer = developer.trim();
    }
    
    // Extract Receptionist
    const recMatch = cleanText.match(/(?:推接待|接待)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/i);
    let receptionist = recMatch ? recMatch[1].trim() : '';
    if (receptionist) {
        receptionist = receptionist.replace(/^_+\s*/, '');
        receptionist = receptionist.replace(/\s*_+\s*$/, '');
        receptionist = receptionist.replace(/_/g, ' ');
        receptionist = receptionist.trim();
    }

    // Extract Deposits
    let todayDeposit = 0;
    let monthDeposit = 0;
    
    const todayMatch = cleanText.match(/今日首存[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    if (todayMatch) {
        todayDeposit = parseInt(todayMatch[1], 10) || 0;
    }
    
    const monthMatch = cleanText.match(/本月首存[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    if (monthMatch) {
        monthDeposit = parseInt(monthMatch[1], 10) || 0;
    }

    // Extract additional fields if present
    const remarkMatch = cleanText.match(/(?:备注|备注)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/i);
    const remark = remarkMatch ? remarkMatch[1].trim() : '';

    const channelMatch = cleanText.match(/(?:渠道|来源)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/i);
    const channel = channelMatch ? channelMatch[1].trim() : '';

    return {
        wsAccount: wsAccount,
        platformAccount: platformAccount,
        todayDeposit: todayDeposit,
        monthDeposit: monthDeposit,
        joinDate: joinDate,
        ipStatus: ipStatus,
        developer: developer,
        receptionist: receptionist,
        remark: remark,
        channel: channel,
        rawText: cleanText
    };
}

// =========================
// PARSE JSON DATA FROM TELEGRAM
// =========================
function parseTelegramExport(jsonData) {
    try {
        let data = jsonData;
        if (typeof jsonData === 'string') {
            data = JSON.parse(jsonData);
        }
        
        // Handle different JSON structures
        let records = [];
        
        if (Array.isArray(data)) {
            records = data;
        } else if (data.records && Array.isArray(data.records)) {
            records = data.records;
        } else if (data.data && Array.isArray(data.data)) {
            records = data.data;
        } else if (data.messages && Array.isArray(data.messages)) {
            // Telegram export format
            records = data.messages.map(msg => {
                if (msg.text) {
                    return extractData(msg.text);
                }
                return null;
            }).filter(r => r && r.platformAccount);
        } else {
            // Try to extract from object values
            for (const key in data) {
                if (Array.isArray(data[key])) {
                    records = data[key];
                    break;
                }
            }
        }
        
        return records;
    } catch (err) {
        console.error('Error parsing JSON:', err);
        return null;
    }
}

// =========================
// BULK IMPORT FUNCTION
// =========================
async function bulkImportRecords(recordsData, source = 'telegram_import') {
    if (!Array.isArray(recordsData) || recordsData.length === 0) {
        return { imported: 0, duplicates: 0, errors: 0, total: 0 };
    }

    // Check MongoDB connection
    if (mongoose.connection.readyState !== 1) {
        console.log("❌ MongoDB not ready for bulk import");
        return { imported: 0, duplicates: 0, errors: recordsData.length, total: recordsData.length };
    }

    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    const now = new Date();
    const collectionDate = now.toISOString().split('T')[0];
    const collectionMonth = collectionDate.substring(0, 7);

    const batchSize = 50;
    const batches = [];

    // Prepare records for import
    for (const data of recordsData) {
        if (!data.platformAccount) {
            errors++;
            continue;
        }

        // Check if already exists in DB
        const exists = await Record.findOne({ platformAccount: data.platformAccount });
        if (exists) {
            duplicates++;
            continue;
        }

        const record = new Record({
            wsAccount: data.wsAccount || '',
            platformAccount: data.platformAccount,
            todayDeposit: parseInt(data.todayDeposit) || 0,
            monthDeposit: parseInt(data.monthDeposit) || 0,
            joinDate: data.joinDate || '',
            ipStatus: data.ipStatus || '正常',
            developer: data.developer || '',
            receptionist: data.receptionist || '',
            remark: data.remark || '',
            channel: data.channel || '',
            senderName: 'System Import',
            senderId: 0,
            rawMessage: data.rawText || JSON.stringify(data),
            collectionDate: collectionDate,
            collectionMonth: collectionMonth,
            source: source,
            importedAt: now
        });

        batches.push(record);
    }

    // Process in batches
    for (let i = 0; i < batches.length; i += batchSize) {
        const batch = batches.slice(i, i + batchSize);
        try {
            const result = await Record.insertMany(batch, { ordered: false });
            imported += result.length;
            result.forEach(record => {
                if (record.platformAccount) {
                    accountSet.add(record.platformAccount);
                }
            });
        } catch (err) {
            if (err.code === 11000) {
                // Duplicate key errors
                duplicates += err.writeErrors ? err.writeErrors.filter(e => e.code === 11000).length : 0;
                // Some might still be inserted
                if (err.result && err.result.insertedDocs) {
                    imported += err.result.insertedDocs.length;
                    err.result.insertedDocs.forEach(record => {
                        if (record.platformAccount) {
                            accountSet.add(record.platformAccount);
                        }
                    });
                }
            } else {
                console.error('Batch import error:', err);
                errors += batch.length;
            }
        }
    }

    return { imported, duplicates, errors, total: recordsData.length };
}

// =========================
// SAVE RECORD WITH RETRY
// =========================
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
                return true;
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
// PROCESS MESSAGE
// =========================
async function processMessage(msg) {
    if (!collecting) return;
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;
    
    // Check MongoDB connection
    if (mongoose.connection.readyState !== 1) {
        console.log("📥 Queuing message (MongoDB not ready)");
        messageQueue.push(msg);
        return;
    }

    const text = msg.text.trim();
    const data = extractData(text);

    if (!data.platformAccount) {
        console.log(`⚠️ No account found`);
        return;
    }

    if (accountSet.has(data.platformAccount)) {
        console.log(`⏭️ Duplicate: ${data.platformAccount}`);
        return;
    }

    accountSet.add(data.platformAccount);
    totalRecords++;
    totalTodayDeposit += data.todayDeposit;
    totalMonthDeposit += data.monthDeposit;

    const senderName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || 'User'}`;

    try {
        const now = new Date();
        const collectionDate = now.toISOString().split('T')[0];
        const collectionMonth = collectionDate.substring(0, 7);
        
        const recordData = {
            wsAccount: data.wsAccount,
            platformAccount: data.platformAccount,
            todayDeposit: data.todayDeposit,
            monthDeposit: data.monthDeposit,
            joinDate: data.joinDate,
            ipStatus: data.ipStatus,
            developer: data.developer,
            receptionist: data.receptionist,
            remark: data.remark || '',
            channel: data.channel || '',
            senderName: senderName,
            senderId: msg.from.id,
            rawMessage: text,
            collectionDate: collectionDate,
            collectionMonth: collectionMonth
        };

        const saved = await saveRecordWithRetry(recordData);
        if (saved) {
            console.log(`✅ Saved: ${data.platformAccount}`);
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
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

function isOwner(req, res, next) {
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

            // Get source statistics
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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

app.post('/api/import/json', isAuthenticated, upload.single('jsonFile'), async (req, res) => {
    try {
        let jsonData;
        
        if (req.file) {
            // Read from uploaded file
            const fileContent = fs.readFileSync(req.file.path, 'utf-8');
            jsonData = JSON.parse(fileContent);
            fs.unlinkSync(req.file.path); // Clean up
        } else if (req.body.jsonData) {
            // Read from text input
            jsonData = JSON.parse(req.body.jsonData);
        } else {
            return res.status(400).json({ error: 'No JSON data provided' });
        }

        // Parse the data
        const records = parseTelegramExport(jsonData);
        if (!records || records.length === 0) {
            return res.status(400).json({ error: 'No valid records found in JSON' });
        }

        // Preview first 5 records
        const preview = records.slice(0, 5);

        res.json({
            success: true,
            total: records.length,
            preview: preview,
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
        
        // Update import stats
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
// API ROUTES
// =========================
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

app.get('/api/records', isAuthenticated, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        if (mongoose.connection.readyState !== 1) {
            return res.json({ records: [], total: 0, page: 1, totalPages: 0 });
        }

        const records = await Record.find()
            .sort({ collectedAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Record.countDocuments();

        res.json({
            records,
            total,
            page,
            totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/search', isAuthenticated, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query || mongoose.connection.readyState !== 1) {
            return res.json({ records: [] });
        }

        const records = await Record.find({
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
        }).limit(100);

        res.json({ records });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/record/:id', isAuthenticated, async (req, res) => {
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

app.get('/api/export', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }
        
        const records = await Record.find().sort({ collectedAt: -1 });
        
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

app.get('/api/export/json', isAuthenticated, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }
        
        const records = await Record.find().sort({ collectedAt: -1 });
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=export_${Date.now()}.json`);
        res.json(records);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.post('/api/record', isAuthenticated, async (req, res) => {
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

        const existing = await Record.findOne({ platformAccount });
        if (existing) {
            return res.status(400).json({ error: 'Platform account already exists' });
        }

        const now = new Date();
        const collectionDate = now.toISOString().split('T')[0];
        const collectionMonth = collectionDate.substring(0, 7);

        const record = new Record({
            wsAccount: wsAccount || '',
            platformAccount: platformAccount,
            todayDeposit: parseInt(todayDeposit) || 0,
            monthDeposit: parseInt(monthDeposit) || 0,
            joinDate: joinDate || '',
            ipStatus: ipStatus || '正常',
            developer: developer || '',
            receptionist: receptionist || '',
            remark: remark || '',
            channel: channel || '',
            senderName: senderName || 'Admin',
            senderId: 0,
            rawMessage: rawMessage || `Manual entry: ${platformAccount}`,
            collectionDate: collectionDate,
            collectionMonth: collectionMonth
        });

        await record.save();
        accountSet.add(platformAccount);
        
        res.json({ success: true, message: 'Record added successfully', record });
    } catch (err) {
        console.error('Error adding record:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/record/:id', isAuthenticated, async (req, res) => {
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

app.put('/api/record/:id', isAuthenticated, async (req, res) => {
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

        if (record.platformAccount !== platformAccount) {
            accountSet.delete(record.platformAccount);
            accountSet.add(platformAccount);
        }

        record.wsAccount = wsAccount || '';
        record.platformAccount = platformAccount;
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
        res.status(500).json({ error: err.message });
    }
});

// =========================
// START EXPRESS SERVER
// =========================
function startExpressServer() {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Admin panel running on port ${PORT}`);
        console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    });
}

// =========================
// START BOT
// =========================
async function startBot() {
    try {
        await connectMongoDB();
        bot.startPolling();
        console.log("🤖 Bot polling started");
        startExpressServer();
        
        setInterval(processQueue, 10000);
    } catch (err) {
        console.error("❌ Failed to start bot:", err);
        bot.startPolling();
        console.log("🤖 Bot started without MongoDB");
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
        "ws账号 : 5219241039856\n平台账号:9241039856\n粉日期：18/6\nIP状态：正常\n今日首存 ：5\n本月首存 ：20\n开发：雪瑶\n推接待：涵月"
    ];
    for (const testMsg of testMessages) {
        const data = extractData(testMsg);
        await bot.sendMessage(msg.chat.id, 
            `📝 Test Extraction:\n平台账号: ${data.platformAccount || 'Not found'}\n今日首存: ${data.todayDeposit}\n本月首存: ${data.monthDeposit}\n开发: ${data.developer}\n接待: ${data.receptionist}`
        );
    }
});

bot.onText(/\/import/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    bot.sendMessage(msg.chat.id, 
        `📥 **JSON Import Instructions**\n\n` +
        `Send me a JSON file or JSON data with the following format:\n\n` +
        `\`\`\`json\n` +
        `{\n` +
        `  "records": [\n` +
        `    {\n` +
        `      "platformAccount": "9241039856",\n` +
        `      "wsAccount": "5219241039856",\n` +
        `      "todayDeposit": 5,\n` +
        `      "monthDeposit": 20,\n` +
        `      "joinDate": "18/6",\n` +
        `      "ipStatus": "正常",\n` +
        `      "developer": "雪瑶",\n` +
        `      "receptionist": "涵月"\n` +
        `    }\n` +
        `  ]\n` +
        `}\n` +
        `\`\`\`\n\n` +
        `Or send a Telegram export JSON file.`,
        { parse_mode: 'Markdown' }
    );
});

// Handle document (JSON file) uploads
bot.on("document", async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    if (!msg.document) return;
    
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || 'unknown.json';
    
    // Only process JSON files
    if (!fileName.endsWith('.json')) {
        bot.sendMessage(msg.chat.id, "❌ Please send a JSON file (.json)");
        return;
    }

    try {
        bot.sendMessage(msg.chat.id, "⏳ Processing JSON file...");
        
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
        
        // Download file
        const response = await fetch(fileUrl);
        const jsonText = await response.text();
        const jsonData = JSON.parse(jsonText);

        const records = parseTelegramExport(jsonData);
        if (!records || records.length === 0) {
            bot.sendMessage(msg.chat.id, "❌ No valid records found in JSON");
            return;
        }

        // Show preview
        let previewMsg = `📄 Found ${records.length} records in the JSON file.\n\n`;
        previewMsg += `Preview (first 3):\n`;
        records.slice(0, 3).forEach((r, i) => {
            previewMsg += `${i+1}. Account: ${r.platformAccount || 'N/A'}, WS: ${r.wsAccount || 'N/A'}, Today: ${r.todayDeposit || 0}, Month: ${r.monthDeposit || 0}\n`;
        });

        // Ask for confirmation
        bot.sendMessage(msg.chat.id, previewMsg + `\n\nType /confirm_import to import all records, or /cancel to cancel.`);
        
        // Store records in memory for confirmation
        global._pendingImport = {
            records: records,
            chatId: msg.chat.id,
            timestamp: Date.now()
        };

    } catch (err) {
        console.error('Document processing error:', err);
        bot.sendMessage(msg.chat.id, `❌ Error processing file: ${err.message}`);
    }
});

// Import confirmation command
bot.onText(/\/confirm_import/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    
    if (!global._pendingImport || global._pendingImport.chatId !== msg.chat.id) {
        bot.sendMessage(msg.chat.id, "❌ No pending import found. Send a JSON file first using /import command.");
        return;
    }

    // Check if import is too old (5 minutes)
    if (Date.now() - global._pendingImport.timestamp > 5 * 60 * 1000) {
        bot.sendMessage(msg.chat.id, "❌ Import session expired. Please send the file again.");
        global._pendingImport = null;
        return;
    }

    const records = global._pendingImport.records;
    bot.sendMessage(msg.chat.id, `⏳ Importing ${records.length} records...`);

    try {
        const result = await bulkImportRecords(records, 'telegram_import');
        importStats = {
            total: result.total,
            imported: result.imported,
            duplicates: result.duplicates,
            errors: result.errors
        };

        const statusMsg = `✅ **Import Complete**\n\n` +
            `📊 Total: ${result.total}\n` +
            `✅ Imported: ${result.imported}\n` +
            `⚠️ Duplicates: ${result.duplicates}\n` +
            `❌ Errors: ${result.errors}\n\n` +
            `Type /summary to see updated totals.`;

        bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: 'Markdown' });
        
        // Clear pending import
        global._pendingImport = null;

    } catch (err) {
        console.error('Import error:', err);
        bot.sendMessage(msg.chat.id, `❌ Import failed: ${err.message}`);
    }
});

bot.onText(/\/cancel/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;
    if (global._pendingImport) {
        global._pendingImport = null;
        bot.sendMessage(msg.chat.id, "✅ Import cancelled");
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

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, closing connections...');
    mongoose.connection.close();
    bot.stopPolling();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
