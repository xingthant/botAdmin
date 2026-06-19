require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const Record = require("./models/Record");

// =========================
// ENVIRONMENT VALIDATION
// =========================
const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID) || 7756391343;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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
console.log(`🔑 Admin password set: ${ADMIN_PASSWORD ? 'Yes' : 'No'}`);

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

// =========================
// EXTRACT DATA FUNCTION
// =========================
function extractData(text) {
    console.log('🔍 Processing text:', text.substring(0, 100) + '...');
    
    // Extract Ws账号
    const wsMatch = text.match(/(?:Ws账号|WS账号|ws账号)[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    const wsAccount = wsMatch ? wsMatch[1].trim() : null;
    
    // Extract 平台账号 or 会员账户
    const accountMatch = text.match(/(?:平台账号|会员账户|会员账号)[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    let platformAccount = accountMatch ? accountMatch[1].trim() : null;
    
    if (!platformAccount) {
        const allNumbers = text.match(/\b(\d{10,13})\b/g);
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
    
    // Extract 进粉日期
    const dateMatch = text.match(/(?:进粉日期|日期|进粉)[\s\u3000]*[：:；;][\s\u3000]*([^\s\n]+)/);
    const joinDate = dateMatch ? dateMatch[1].trim() : '';
    
    // Extract IP状态
    const ipMatch = text.match(/(?:IP状态|IP)[\s\u3000]*[：:；;][\s\u3000]*([^\s\n]+)/);
    const ipStatus = ipMatch ? ipMatch[1].trim() : '正常';
    
    // Extract 开发
    const devMatch = text.match(/(?:开发|开发者)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/);
    let developer = devMatch ? devMatch[1].trim() : '';
    if (developer) {
        developer = developer.replace(/\s*\/\/\/\/\/\s*/g, ' // ');
        developer = developer.replace(/\s*\/\s*/g, ' / ');
        developer = developer.replace(/\s{2,}/g, ' ');
        developer = developer.trim();
    }
    
    // Extract 推接待
    const recMatch = text.match(/(?:推接待|接待)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/);
    let receptionist = recMatch ? recMatch[1].trim() : '';
    if (receptionist) {
        receptionist = receptionist.replace(/^_+\s*/, '');
        receptionist = receptionist.replace(/\s*_+\s*$/, '');
        receptionist = receptionist.replace(/_/g, ' ');
        receptionist = receptionist.trim();
    }

    // Extract deposits
    let todayDeposit = 0;
    let monthDeposit = 0;
    
    const todayMatch = text.match(/今日首存[\s\u3000]*[：:；;][\s\u3000]*(\d+)/);
    if (todayMatch) {
        todayDeposit = parseInt(todayMatch[1], 10);
    }
    
    const monthMatch = text.match(/本月首存[\s\u3000]*[：:；;][\s\u3000]*(\d+)/);
    if (monthMatch) {
        monthDeposit = parseInt(monthMatch[1], 10);
    }

    return {
        wsAccount: wsAccount,
        platformAccount: platformAccount,
        todayDeposit: todayDeposit,
        monthDeposit: monthDeposit,
        joinDate: joinDate,
        ipStatus: ipStatus,
        developer: developer,
        receptionist: receptionist
    };
}

// =========================
// LOAD EXISTING ACCOUNTS
// =========================
async function loadExistingAccounts() {
    try {
        if (!isMongoConnected) return;
        const accounts = await Record.find({}, 'platformAccount');
        accounts.forEach(record => {
            if (record.platformAccount) {
                accountSet.add(record.platformAccount);
            }
        });
        console.log(`✅ Loaded ${accountSet.size} existing accounts from database`);
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
        });
        isMongoConnected = true;
        console.log("✅ Connected to MongoDB");
        await loadExistingAccounts();
        return true;
    } catch (err) {
        console.error("❌ MongoDB Connection Error:", err.message);
        isMongoConnected = false;
        return false;
    }
}

// =========================
// START BOT
// =========================
async function startBot() {
    try {
        // Connect to MongoDB first
        await connectMongoDB();
        
        // Start bot polling
        bot.startPolling();
        console.log("🤖 Bot polling started");
        
        // Start Express server
        startExpressServer();
    } catch (err) {
        console.error("❌ Failed to start bot:", err);
        // Try to start without MongoDB
        bot.startPolling();
        console.log("🤖 Bot started without MongoDB");
        startExpressServer();
    }
}

// =========================
// EXPRESS SERVER
// =========================
const app = express();

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// SESSION CONFIGURATION - FIXED
// =========================
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this-to-something-random',
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
// AUTHENTICATION WITH LOGGING
// =========================
function isAuthenticated(req, res, next) {
    console.log('🔍 Auth check - Session:', req.session);
    console.log('🔍 Auth check - isAdmin:', req.session?.isAdmin);
    
    if (req.session && req.session.isAdmin) {
        console.log('✅ Authenticated, proceeding');
        next();
    } else {
        console.log('❌ Not authenticated, redirecting to login');
        res.redirect('/login');
    }
}

// =========================
// HEALTH CHECK (for Render)
// =========================
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mongo: isMongoConnected ? 'connected' : 'disconnected',
        bot: 'running',
        collecting: collecting,
        records: accountSet.size
    });
});

// =========================
// LOGIN ROUTES - FIXED
// =========================
app.get('/login', (req, res) => {
    // Clear any existing session first
    if (req.session) {
        req.session.isAdmin = false;
    }
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    console.log(`🔐 Login attempt with password: ${password}`);
    console.log(`🔐 Expected password: ${ADMIN_PASSWORD}`);
    
    // Trim both to avoid whitespace issues
    const trimmedPassword = password ? password.trim() : '';
    const trimmedAdminPassword = ADMIN_PASSWORD ? ADMIN_PASSWORD.trim() : '';
    
    if (trimmedPassword === trimmedAdminPassword) {
        req.session.isAdmin = true;
        console.log('✅ Login successful! Session created.');
        console.log('Session ID:', req.sessionID);
        console.log('Session data:', req.session);
        
        // Force save session before redirect
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.render('login', { error: 'Session error, please try again' });
            }
            console.log('✅ Session saved successfully');
            res.redirect('/dashboard');
        });
    } else {
        console.log('❌ Login failed - password mismatch');
        res.render('login', { error: 'Invalid password' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/login');
    });
});

// =========================
// DEBUG ROUTE
// =========================
app.get('/debug-session', (req, res) => {
    res.json({
        sessionID: req.sessionID,
        session: req.session,
        isAdmin: req.session?.isAdmin || false,
        headers: req.headers,
        cookies: req.headers.cookie || 'No cookies'
    });
});

// =========================
// DASHBOARD ROUTE
// =========================
app.get('/dashboard', isAuthenticated, async (req, res) => {
    console.log('📊 Dashboard accessed, session:', req.session.isAdmin);
    try {
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = today.substring(0, 7);

        let total = 0, unique = 0, todayCount = 0, monthCount = 0, todaySum = 0, monthSum = 0;
        let recentRecords = [];

        if (isMongoConnected) {
            [total, unique, todayCount, monthCount, todaySum, monthSum] = await Promise.all([
                Record.countDocuments(),
                Record.distinct('platformAccount').then(arr => arr.length),
                Record.countDocuments({ collectionDate: today }),
                Record.countDocuments({ collectionMonth: currentMonth }),
                Record.aggregate([
                    { $match: { collectionDate: today } },
                    { $group: { _id: null, total: { $sum: "$todayDeposit" } } }
                ]).then(result => result[0]?.total || 0),
                Record.aggregate([
                    { $match: { collectionMonth: currentMonth } },
                    { $group: { _id: null, total: { $sum: "$monthDeposit" } } }
                ]).then(result => result[0]?.total || 0)
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
            collectionStartTime: collectionStartTime
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Error loading dashboard');
    }
});

app.get('/records', isAuthenticated, (req, res) => {
    res.render('records');
});

app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// =========================
// API ROUTES
// =========================
app.get('/api/stats', isAuthenticated, async (req, res) => {
    try {
        const total = isMongoConnected ? await Record.countDocuments() : 0;
        const unique = isMongoConnected ? await Record.distinct('platformAccount').then(arr => arr.length) : 0;
        const today = new Date().toISOString().split('T')[0];
        const todayCount = isMongoConnected ? await Record.countDocuments({ collectionDate: today }) : 0;
        
        res.json({
            totalRecords: total,
            uniqueAccounts: unique,
            todayRecords: todayCount,
            collecting: collecting,
            status: collecting ? 'active' : 'stopped',
            mongoConnected: isMongoConnected
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

        if (!isMongoConnected) {
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
        if (!query || !isMongoConnected) {
            return res.json({ records: [] });
        }

        const records = await Record.find({
            $or: [
                { platformAccount: { $regex: query, $options: 'i' } },
                { wsAccount: { $regex: query, $options: 'i' } },
                { senderName: { $regex: query, $options: 'i' } },
                { receptionist: { $regex: query, $options: 'i' } },
                { developer: { $regex: query, $options: 'i' } },
                { rawMessage: { $regex: query, $options: 'i' } }
            ]
        }).limit(100);

        res.json({ records });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/record/:id', isAuthenticated, async (req, res) => {
    try {
        if (!isMongoConnected) {
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
        if (!isMongoConnected) {
            return res.status(503).json({ error: 'MongoDB not connected' });
        }
        
        const records = await Record.find().sort({ collectedAt: -1 });
        
        let csv = "Platform Account,Today Deposit,Month Deposit,Sender,Date,Message\n";
        records.forEach(r => {
            const message = r.rawMessage.replace(/"/g, '""');
            csv += `${r.platformAccount},${r.todayDeposit},${r.monthDeposit},${r.senderName},${r.collectedAt},"${message}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=export_${Date.now()}.csv`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clear', isAuthenticated, async (req, res) => {
    try {
        if (!isMongoConnected) {
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
// ADD NEW RECORD (POST)
// =========================
app.post('/api/record', isAuthenticated, async (req, res) => {
    try {
        if (!isMongoConnected) {
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
            senderName,
            rawMessage
        } = req.body;

        // Validate required fields
        if (!platformAccount) {
            return res.status(400).json({ error: 'Platform account is required' });
        }

        // Check for duplicate
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

// =========================
// GET SINGLE RECORD
// =========================
app.get('/api/record/:id', isAuthenticated, async (req, res) => {
    try {
        if (!isMongoConnected) {
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

// =========================
// UPDATE RECORD (PUT)
// =========================
app.put('/api/record/:id', isAuthenticated, async (req, res) => {
    try {
        if (!isMongoConnected) {
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

        // If platform account is changing, update the set
        if (record.platformAccount !== platformAccount) {
            accountSet.delete(record.platformAccount);
            accountSet.add(platformAccount);
        }

        // Update fields
        record.wsAccount = wsAccount || '';
        record.platformAccount = platformAccount;
        record.todayDeposit = parseInt(todayDeposit) || 0;
        record.monthDeposit = parseInt(monthDeposit) || 0;
        record.joinDate = joinDate || '';
        record.ipStatus = ipStatus || '正常';
        record.developer = developer || '';
        record.receptionist = receptionist || '';
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
        console.log(`🔗 Debug session: http://localhost:${PORT}/debug-session`);
    });
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

    bot.sendMessage(msg.chat.id, "🚀 Collection Started! Data will be saved to MongoDB");
});

bot.onText(/\/summary/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;

    try {
        if (!isMongoConnected) {
            return bot.sendMessage(msg.chat.id, "❌ MongoDB is not connected");
        }

        const today = new Date().toISOString().split('T')[0];
        const currentMonth = today.substring(0, 7);

        const [todayCount, monthCount, totalCount] = await Promise.all([
            Record.countDocuments({ collectionDate: today }),
            Record.countDocuments({ collectionMonth: currentMonth }),
            Record.countDocuments()
        ]);

        const [todaySum, monthSum, totalSum] = await Promise.all([
            Record.aggregate([
                { $match: { collectionDate: today } },
                { $group: { _id: null, total: { $sum: "$todayDeposit" } } }
            ]),
            Record.aggregate([
                { $match: { collectionMonth: currentMonth } },
                { $group: { _id: null, total: { $sum: "$monthDeposit" } } }
            ]),
            Record.aggregate([
                { $group: { _id: null, total: { $sum: "$todayDeposit" } } }
            ])
        ]);

        const status = collecting ? "🟢 Active" : "🔴 Stopped";
        bot.sendMessage(
            msg.chat.id,
            `📊 Summary\n\n` +
            `Status: ${status}\n` +
            `MongoDB: ${isMongoConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
            `Today Records: ${todayCount}\n` +
            `Today Deposit: ${todaySum[0]?.total || 0}\n\n` +
            `Month Records: ${monthCount}\n` +
            `Month Deposit: ${monthSum[0]?.total || 0}\n\n` +
            `Total Records: ${totalCount}\n` +
            `Total Deposit: ${totalSum[0]?.total || 0}`
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

    try {
        if (!isMongoConnected) {
            return bot.sendMessage(msg.chat.id, "❌ MongoDB is not connected");
        }

        const allRecords = await Record.find()
            .sort({ collectedAt: -1 })
            .limit(1000);

        let report = `
===== REPORT =====

Total Records: ${await Record.countDocuments()}
Total Unique Accounts: ${await Record.distinct('platformAccount').then(arr => arr.length)}

========================

${allRecords.map(r => 
    `[Sender: ${r.senderName}]\n${r.rawMessage}\n` +
    `Platform: ${r.platformAccount} | Today: ${r.todayDeposit} | Month: ${r.monthDeposit}`
).join('\n\n----------------------\n\n')}
`;

        const fileName = `report_${Date.now()}.txt`;
        fs.writeFileSync(fileName, report);

        await bot.sendDocument(msg.chat.id, fileName);
        
        const stats = await Record.aggregate([
            { $group: {
                _id: null,
                totalRecords: { $sum: 1 },
                totalToday: { $sum: "$todayDeposit" },
                totalMonth: { $sum: "$monthDeposit" }
            }}
        ]);

        bot.sendMessage(
            msg.chat.id,
            `✅ Collection Stopped\n\n` +
            `Records: ${stats[0]?.totalRecords || 0}\n` +
            `Today Total: ${stats[0]?.totalToday || 0}\n` +
            `Month Total: ${stats[0]?.totalMonth || 0}`
        );

        if (fs.existsSync(fileName)) {
            fs.unlinkSync(fileName);
        }
    } catch (err) {
        console.error('Error generating report:', err);
        bot.sendMessage(msg.chat.id, "❌ Error generating report");
    }
});

bot.onText(/\/status/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;

    const status = collecting ? "🟢 Active" : "🔴 Stopped";
    const total = isMongoConnected ? await Record.countDocuments() : 0;
    const unique = isMongoConnected ? await Record.distinct('platformAccount').then(arr => arr.length) : 0;
    
    let timeRunning = "N/A";
    if (collectionStartTime) {
        const diff = Math.floor((Date.now() - collectionStartTime) / 1000);
        const hours = Math.floor(diff / 3600);
        const minutes = Math.floor((diff % 3600) / 60);
        timeRunning = `${hours}h ${minutes}m`;
    }

    bot.sendMessage(
        msg.chat.id,
        `🤖 Bot Status\n\n` +
        `Status: ${status}\n` +
        `Running: ${timeRunning}\n` +
        `MongoDB: ${isMongoConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
        `Total Records: ${total}\n` +
        `Unique Accounts: ${unique}\n` +
        `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    );
});

bot.onText(/\/test/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return;

    const testMessages = [
        "Ws账号 :  5219241039856\n平台账号:9241039856\n进粉日期：18/6\nIP状态：正常\n今日首存 ：            5\n本月首存​​​​​​ ：20\n开发：雪瑶   //////  蕊非\n推接待_    涵月",
        "平台账号: 9612678130\n今日首存: 3\n本月首存: 58",
        "会员账户: 9372274807\n今日首存: 3\n本月首存: 59"
    ];

    for (const testMsg of testMessages) {
        const data = extractData(testMsg);
        await bot.sendMessage(
            msg.chat.id,
            `📝 Test Extraction:\n\n` +
            `Raw:\n${testMsg}\n\n` +
            `Extracted:\n` +
            `Ws账号: ${data.wsAccount || 'Not found'}\n` +
            `平台账号: ${data.platformAccount || 'Not found'}\n` +
            `进粉日期: ${data.joinDate || 'Not found'}\n` +
            `IP状态: ${data.ipStatus || 'Not found'}\n` +
            `今日首存: ${data.todayDeposit}\n` +
            `本月首存: ${data.monthDeposit}\n` +
            `开发: ${data.developer || 'Not found'}\n` +
            `推接待: ${data.receptionist || 'Not found'}`
        );
    }
});

// =========================
// MESSAGE HANDLER
// =========================
bot.on("message", async (msg) => {
    if (!collecting) return;
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;
    if (!isMongoConnected) {
        console.log("⚠️ MongoDB not connected, skipping save");
        return;
    }

    const text = msg.text.trim();
    const data = extractData(text);

    if (!data.platformAccount) {
        console.log(`⚠️ No account found in: ${text.substring(0, 50)}...`);
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
    records.push(`[Sender: ${senderName}]\n${text}`);

    try {
        const now = new Date();
        const collectionDate = now.toISOString().split('T')[0];
        const collectionMonth = collectionDate.substring(0, 7);
        
        const record = new Record({
            wsAccount: data.wsAccount,
            platformAccount: data.platformAccount,
            todayDeposit: data.todayDeposit,
            monthDeposit: data.monthDeposit,
            joinDate: data.joinDate,
            ipStatus: data.ipStatus,
            developer: data.developer,
            receptionist: data.receptionist,
            senderName: senderName,
            senderId: msg.from.id,
            rawMessage: text,
            collectionDate: collectionDate,
            collectionMonth: collectionMonth
        });

        await record.save();
        console.log(`✅ Saved: ${data.platformAccount} (Today: ${data.todayDeposit}, Month: ${data.monthDeposit})`);
    } catch (err) {
        if (err.code === 11000) {
            console.log(`⚠️ Duplicate in DB: ${data.platformAccount}`);
            accountSet.delete(data.platformAccount);
        } else {
            console.error('❌ Error saving:', err);
        }
    }
});

// =========================
// ERROR HANDLING
// =========================
bot.on("polling_error", (err) => {
    console.log("❌ Polling error:", err.code || err.message);
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
