require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const Record = require("./models/Record");

const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = 7756391343;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const bot = new TelegramBot(TOKEN, {
    polling: false
});

// =========================
// CONNECT TO MONGODB
// =========================
mongoose.connect(MONGODB_URI)
.then(async () => {
    console.log("✅ Connected to MongoDB");
    await loadExistingAccounts();
    await bot.startPolling();
    console.log("🤖 Bot polling started");
})
.catch(err => {
    console.error("❌ MongoDB Error:", err);
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
// STATE
// =========================
let collecting = false;
let records = [];
let accountSet = new Set();
let totalRecords = 0;
let totalTodayDeposit = 0;
let totalMonthDeposit = 0;
let collectionStartTime = null;

// =========================
// IMPROVED EXTRACTION - SUPPORTS MULTIPLE FORMATS
// =========================
function extractData(text) {
    console.log('🔍 Processing text:', text);
    
    // Extract Ws账号 - look for Ws账号 with any spacing
    const wsMatch = text.match(/(?:Ws账号|WS账号|ws账号)[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    const wsAccount = wsMatch ? wsMatch[1].trim() : null;
    
    // Extract 平台账号 or 会员账户
    const accountMatch = text.match(/(?:平台账号|会员账户|会员账号)[\s\u3000]*[：:；;][\s\u3000]*(\d+)/i);
    let platformAccount = accountMatch ? accountMatch[1].trim() : null;
    
    // If no platform account found, try to find any 10-13 digit number (but not the Ws账号)
    if (!platformAccount) {
        const allNumbers = text.match(/\b(\d{10,13})\b/g);
        if (allNumbers) {
            // Find the number that's NOT the Ws账号
            for (const num of allNumbers) {
                if (num !== wsAccount) {
                    platformAccount = num;
                    break;
                }
            }
            // If still not found, use the first number
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
    
    // Extract 开发 - handle multiple slashes and spaces
    const devMatch = text.match(/(?:开发|开发者)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/);
    let developer = devMatch ? devMatch[1].trim() : '';
    if (developer) {
        // Clean up: remove extra slashes and spaces
        developer = developer.replace(/\s*\/\/\/\/\/\s*/g, ' // ');  // Multiple slashes
        developer = developer.replace(/\s*\/\s*/g, ' / ');           // Single slash
        developer = developer.replace(/\s{2,}/g, ' ');               // Multiple spaces
        developer = developer.trim();
    }
    
    // Extract 推接待 - handle underscores and other separators
    const recMatch = text.match(/(?:推接待|接待)[\s\u3000]*[：:；;][\s\u3000]*([^\n]+)/);
    let receptionist = recMatch ? recMatch[1].trim() : '';
    if (receptionist) {
        // Clean up: remove underscores and special chars
        receptionist = receptionist.replace(/^_+\s*/, '');  // Remove leading underscores
        receptionist = receptionist.replace(/\s*_+\s*$/, ''); // Remove trailing underscores
        receptionist = receptionist.replace(/_/g, ' ');      // Replace underscores with spaces
        receptionist = receptionist.trim();
    }

    // Extract deposits - look for numbers after "今日首存" and "本月首存"
    let todayDeposit = 0;
    let monthDeposit = 0;
    
    // Today deposit - find the number after "今日首存"
    const todayMatch = text.match(/今日首存[\s\u3000]*[：:；;][\s\u3000]*(\d+)/);
    if (todayMatch) {
        todayDeposit = parseInt(todayMatch[1], 10);
    }
    
    // Month deposit - find the number after "本月首存"
    const monthMatch = text.match(/本月首存[\s\u3000]*[：:；;][\s\u3000]*(\d+)/);
    if (monthMatch) {
        monthDeposit = parseInt(monthMatch[1], 10);
    }

    // Debug logging
    console.log('📝 Extracted:');
    console.log(`   Ws账号: ${wsAccount}`);
    console.log(`   平台账号: ${platformAccount}`);
    console.log(`   进粉日期: ${joinDate}`);
    console.log(`   IP状态: ${ipStatus}`);
    console.log(`   今日首存: ${todayDeposit}`);
    console.log(`   本月首存: ${monthDeposit}`);
    console.log(`   开发: ${developer}`);
    console.log(`   推接待: ${receptionist}`);

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
    const total = await Record.countDocuments();
    const unique = await Record.distinct('platformAccount').then(arr => arr.length);
    
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
// EXPRESS ADMIN PANEL
// =========================
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Authentication middleware
function isAuthenticated(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}

// =========================
// WEB ROUTES
// =========================

// Login page
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Invalid password' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Dashboard
app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = today.substring(0, 7);

        const [total, unique, todayCount, monthCount, todaySum, monthSum] = await Promise.all([
            Record.countDocuments(),
            Record.distinct('platformAccount').then(arr => arr.length),
            Record.countDocuments({ collectionDate: today }),
            Record.countDocuments({ collectionMonth: currentMonth }),
            Record.aggregate([
                { $match: { collectionDate: today } },
                { $group: { _id: null, total: { $sum: "$todayDeposit" } } }
            ]),
            Record.aggregate([
                { $match: { collectionMonth: currentMonth } },
                { $group: { _id: null, total: { $sum: "$monthDeposit" } } }
            ])
        ]);

        const recentRecords = await Record.find()
            .sort({ collectedAt: -1 })
            .limit(10);

        res.render('dashboard', {
            status: collecting ? 'active' : 'stopped',
            totalRecords: total,
            uniqueAccounts: unique,
            todayRecords: todayCount,
            todayDeposit: todaySum[0]?.total || 0,
            monthRecords: monthCount,
            monthDeposit: monthSum[0]?.total || 0,
            recentRecords: recentRecords,
            collectionStartTime: collectionStartTime
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Error loading dashboard');
    }
});

// API - Get stats
app.get('/api/stats', isAuthenticated, async (req, res) => {
    try {
        const total = await Record.countDocuments();
        const unique = await Record.distinct('platformAccount').then(arr => arr.length);
        const today = new Date().toISOString().split('T')[0];
        const todayCount = await Record.countDocuments({ collectionDate: today });
        
        res.json({
            totalRecords: total,
            uniqueAccounts: unique,
            todayRecords: todayCount,
            collecting: collecting,
            status: collecting ? 'active' : 'stopped'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API - Toggle collection
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

// API - Get records with pagination
app.get('/api/records', isAuthenticated, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

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

// API - Search records
app.get('/api/search', isAuthenticated, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.json({ records: [] });
        }

        const records = await Record.find({
            $or: [
                { platformAccount: { $regex: query, $options: 'i' } },
                { senderName: { $regex: query, $options: 'i' } },
                { rawMessage: { $regex: query, $options: 'i' } }
            ]
        }).limit(100);

        res.json({ records });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API - Delete record
app.delete('/api/record/:id', isAuthenticated, async (req, res) => {
    try {
        const deleted = await Record.findByIdAndDelete(req.params.id);
        if (deleted) {
            // Remove from accountSet if no other records with this account exist
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

// API - Export CSV
app.get('/api/export', isAuthenticated, async (req, res) => {
    try {
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

// API - Clear all data
app.post('/api/clear', isAuthenticated, async (req, res) => {
    try {
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

app.get('/records', isAuthenticated, (req, res) => {
    res.render('records');
});

// Redirect root to dashboard
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Admin panel running on http://localhost:${PORT}`);
});

console.log("🤖 Bot with improved extraction and admin panel started...");

