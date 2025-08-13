const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');

// --- 引入上一级目录的 config.js ---
const appConfig = require('../config.js'); 
// ----------------------------------

const app = express();
const PORT = 3000; // Node.js 后端监听的端口

// 从 appConfig 获取 DEBUG_MODE
const DEBUG_MODE = appConfig.DEBUG_MODE;

// 根据 DEBUG_MODE 和 config.js 中的 DOMAIN 构造 BASE_URL
// 这个 BASE_URL 用于后端生成图片和二维码的完整 URL
const BASE_URL = DEBUG_MODE ? `http://localhost:${PORT}` : `http://${appConfig.DOMAIN}`;

// --- 配置 CORS ---
let corsOrigins;
if (DEBUG_MODE) {
    corsOrigins = '*'; // 开发环境下允许所有来源
} else {
    // 生产环境下，明确列出允许的域名，包括 HTTP 和 HTTPS
    // 确保这里的域名与您的 Nginx 配置和实际访问域名一致
    const domain = appConfig.DOMAIN;
    corsOrigins = [
        `http://${domain}`,
        `http://www.${domain}`,
        `https://${domain}`,
        `https://www.${domain}`
    ];
}

app.use(cors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Type']
}));

// --- 配置 Express 解析 JSON ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 文件存储配置 ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const QRCODE_DIR = path.join(__dirname, 'qrcodes');
const PORTFOLIO_DIR = path.join(__dirname, 'portfolio_uploads'); // 新增作品集上传目录
const DB_FILE = path.join(__dirname, 'db.json'); // 数据库文件路径

// 确保目录存在
fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
fsSync.mkdirSync(QRCODE_DIR, { recursive: true });
fsSync.mkdirSync(PORTFOLIO_DIR, { recursive: true }); // 确保作品集目录存在

// 配置 Multer 存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // *** 关键修改在这里：使用 req.path 进行判断 ***
        // req.path 会是 Nginx 代理后，后端实际接收到的路径，例如 '/upload' 或 '/portfolio/upload'
        if (req.path === '/upload') {
            cb(null, UPLOAD_DIR);
        } else if (req.path === '/portfolio/upload') {
            cb(null, PORTFOLIO_DIR);
        } else {
            // 如果请求路径不匹配任何已知上传路径，则抛出错误
            console.error('Unexpected upload path:', req.path, req.originalUrl);
            cb(new Error('Invalid upload path: ' + req.path), null);
        }
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadMiddleware = multer({ storage: storage });

// --- 数据库操作函数 ---
let dbData = {
    sessions: {},
    portfolioItems: [] // 新增作品集数据
};

async function loadData() {
    try {
        const data = await fs.readFile(DB_FILE, 'utf8');
        dbData = JSON.parse(data);
        // 确保 portfolioItems 存在
        if (!dbData.portfolioItems) {
            dbData.portfolioItems = [];
        }
        console.log('数据从 db.json 加载成功。');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn('db.json 文件不存在，将创建新的空数据库。');
            dbData = { sessions: {}, portfolioItems: [] }; // 初始化空数据
            await saveData(); // 创建空文件
        } else {
            console.error('从 db.json 加载数据失败:', error);
            dbData = { sessions: {}, portfolioItems: [] };
        }
    }
}

async function saveData() {
    try {
        await fs.writeFile(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
        console.log('数据保存到 db.json 成功。');
    } catch (error) {
        console.error('保存数据到 db.json 失败:', error);
    }
}

// 辅助函数，用于在创建新会话时记录时间
function createNewSession(sessionId, customerName = '未知客户') {
    dbData.sessions[sessionId] = {
        customerName: customerName,
        photos: [],
        status: 'draft',
        createdAt: new Date().toISOString()
    };
}

// --- 静态文件服务 ---
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/qrcodes', express.static(QRCODE_DIR));
app.use('/portfolio_uploads', express.static(PORTFOLIO_DIR)); // 新增作品集静态文件服务

// --- API 接口 ---

/**
 * 摄影师上传照片接口
 * POST /upload
 */
app.post('/upload', uploadMiddleware.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ code: 1, message: '没有接收到文件' });
    }

    const photoId = uuidv4();
    let currentSessionId = req.body.sessionId;
    const customerName = req.body.customerName || '未知客户';

    if (!currentSessionId) {
        currentSessionId = uuidv4();
        createNewSession(currentSessionId, customerName);
    } else if (!dbData.sessions[currentSessionId]) {
        createNewSession(currentSessionId, customerName);
    } else {
        if (customerName && dbData.sessions[currentSessionId].customerName === '未知客户') {
             dbData.sessions[currentSessionId].customerName = customerName;
        }
    }

    const photoUrl = `${BASE_URL}/uploads/${req.file.filename}`;

    dbData.sessions[currentSessionId].photos.push({
        id: photoId,
        url: photoUrl,
        filename: req.file.filename,
        selected: false
    });

    await saveData();
    console.log(`照片 ${photoId} 上传成功，会话ID: ${currentSessionId}, 客户: ${customerName}`);
    res.json({
        code: 0,
        message: 'success',
        photoId: photoId,
        photoUrl: photoUrl,
        sessionId: currentSessionId
    });
});

/**
 * 摄影师删除单张照片接口
 * DELETE /photo/:sessionId/:photoId
 */
app.delete('/photo/:sessionId/:photoId', async (req, res) => {
    const { sessionId, photoId } = req.params;

    if (!dbData.sessions[sessionId]) {
        return res.status(404).json({ code: 1, message: '会话不存在' });
    }

    const sessionPhotos = dbData.sessions[sessionId].photos;
    const photoIndex = sessionPhotos.findIndex(p => p.id === photoId);

    if (photoIndex === -1) {
        return res.status(404).json({ code: 1, message: '照片不存在于该会话中' });
    }

    const photoToDelete = sessionPhotos[photoIndex];
    const filename = photoToDelete.filename;
    const filePath = path.join(UPLOAD_DIR, filename);

    sessionPhotos.splice(photoIndex, 1);

    if (sessionPhotos.length === 0) {
        delete dbData.sessions[sessionId];
        console.log(`会话 ${sessionId} 已无照片，已删除。`);
    }

    try {
        await fs.unlink(filePath);
        console.log(`照片 ${photoId} 及其文件 ${filename} 已删除。`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`文件不存在，可能已被删除: ${filePath}`);
        } else {
            console.error(`删除文件失败: ${filePath}, 错误:`, err);
        }
    }
    await saveData();
    res.json({ code: 0, message: '照片删除成功' });
});

/**
 * 摄影师删除整个会话接口
 * DELETE /session/:sessionId
 * @param {string} sessionId - 要删除的会话ID
 * @returns {json} { code: 0, message: 'success' }
 */
app.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    if (!dbData.sessions[sessionId]) {
        return res.status(404).json({ code: 1, message: '会话不存在' });
    }

    const sessionToDelete = dbData.sessions[sessionId];
    const photosToDelete = sessionToDelete.photos;

    // 删除所有关联的物理文件
    const deleteFilePromises = photosToDelete.map(photo => {
        const filePath = path.join(UPLOAD_DIR, photo.filename);
        return fs.unlink(filePath)
            .then(() => console.log(`已删除文件: ${photo.filename}`))
            .catch(err => {
                if (err.code === 'ENOENT') {
                    console.warn(`文件不存在，可能已被删除: ${filePath}`);
                } else {
                    console.error(`删除文件失败: ${filePath}, 错误:`, err);
                }
            });
    });

    await Promise.all(deleteFilePromises); // 等待所有文件删除完成

    // 从内存和数据库中删除会话
    delete dbData.sessions[sessionId];
    await saveData();

    console.log(`会话 ${sessionId} 及其所有照片已删除。`);
    res.json({ code: 0, message: '会话及其所有照片删除成功' });
});


/**
 * 摄影师完成本次会话接口
 * POST /finishSession
 */
app.post('/finishSession', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId || !dbData.sessions[sessionId]) {
        return res.status(404).json({ code: 1, message: '会话不存在' });
    }
    if (dbData.sessions[sessionId].photos.length === 0) {
        return res.status(400).json({ code: 1, message: '会话中没有照片，无法完成' });
    }

    dbData.sessions[sessionId].status = 'ready';
    await saveData();
    console.log(`会话 ${sessionId} 已标记为 ready`);
    res.json({ code: 0, message: '会话已完成，客户可以选片了！' });
});

/**
 * 获取所有会话列表（供摄影师查看），支持筛选、搜索、分页
 * GET /sessions
 */
app.get('/sessions', (req, res) => {
    const { status, search, page = 1, limit = 10 } = req.query;

    let filteredSessions = Object.keys(dbData.sessions).map(id => ({
        id: id,
        customerName: dbData.sessions[id].customerName,
        status: dbData.sessions[id].status,
        photoCount: dbData.sessions[id].photos.length,
        createdAt: dbData.sessions[id].createdAt
    }));

    if (status && status !== 'all') {
        filteredSessions = filteredSessions.filter(s => s.status === status);
    }

    if (search) {
        const lowerCaseSearch = search.toLowerCase();
        filteredSessions = filteredSessions.filter(s =>
            s.id.toLowerCase().includes(lowerCaseSearch) ||
            s.customerName.toLowerCase().includes(lowerCaseSearch)
        );
    }

    filteredSessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = filteredSessions.length;
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedSessions = filteredSessions.slice(startIndex, endIndex);

    res.json({
        code: 0,
        message: 'success',
        sessions: paginatedSessions,
        total: total,
        page: parseInt(page),
        limit: parseInt(limit)
    });
});


/**
 * 获取照片列表接口 (供客户和摄影师查看)
 * GET /photos
 */
app.get('/photos', (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId || !dbData.sessions[sessionId]) {
        return res.status(404).json({ code: 1, message: '选片码无效或会话不存在' });
    }

    const isPhotographer = req.headers['x-client-type'] === 'photographer';
    if (dbData.sessions[sessionId].status === 'draft' && !isPhotographer) {
        return res.status(403).json({ code: 1, message: '该选片码尚未准备好，请联系摄影师' });
    }

    const photosForClient = dbData.sessions[sessionId].photos.map(p => ({
        id: p.id,
        url: p.url,
        selected: p.selected
    }));

    console.log(`获取会话 ${sessionId} 的照片列表`);
    res.json({
        code: 0,
        message: 'success',
        photos: photosForClient
    });
});

/**
 * 客户提交选片结果接口
 * POST /submitSelection
 */
app.post('/submitSelection', async (req, res) => {
    const { sessionId, selectedPhotoIds } = req.body;

    if (!sessionId || !dbData.sessions[sessionId]) {
        return res.status(404).json({ code: 1, message: '选片码无效或会话不存在' });
    }
    if (!Array.isArray(selectedPhotoIds)) {
        return res.status(400).json({ code: 1, message: 'selectedPhotoIds 必须是数组' });
    }

    dbData.sessions[sessionId].photos.forEach(photo => {
        photo.selected = selectedPhotoIds.includes(photo.id);
    });
    dbData.sessions[sessionId].status = 'submitted';
    await saveData();

    console.log(`会话 ${sessionId} 选片结果已提交。已选照片ID:`, selectedPhotoIds);
    res.json({ code: 0, message: '选片结果提交成功！' });
});

/**
 * 生成选片二维码接口
 * POST /generateQRCode
 */
app.post('/generateQRCode', async (req, res) => {
    const { sessionId, page } = req.body;

    if (!sessionId || !page) {
        return res.status(400).json({ code: 1, message: 'sessionId 和 page 不能为空' });
    }
    if (!dbData.sessions[sessionId] || dbData.sessions[sessionId].photos.length === 0) {
        return res.status(400).json({ code: 1, message: '会话不存在或会话中没有照片，无法生成二维码' });
    }

    const miniProgramPath = `${page}?sessionId=${sessionId}`;
    const qrCodeFileName = `qrcode-${sessionId}.png`;
    const qrCodeFilePath = path.join(QRCODE_DIR, qrCodeFileName);
    // 使用 BASE_URL 动态生成 qrCodeUrl
    const qrCodeUrl = `${BASE_URL}/qrcodes/${qrCodeFileName}`;

    try {
        await qrcode.toFile(qrCodeFilePath, miniProgramPath, {
            errorCorrectionLevel: 'H',
            width: 256
        });
        console.log(`二维码生成成功: ${qrCodeUrl}`);
        res.json({ code: 0, message: 'success', qrCodeUrl: qrCodeUrl });
    } catch (err) {
        console.error('生成二维码失败:', err);
        res.status(500).json({ code: 1, message: '生成二维码失败' });
    }
});

// --- 作品集管理 API ---

/**
 * 摄影师上传作品接口
 * POST /portfolio/upload
 * 接收多文件上传
 */
app.post('/portfolio/upload', uploadMiddleware.array('file'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ code: 1, message: '没有接收到文件' });
    }

    const { category } = req.body;
    const defaultTitle = '作品';
    const defaultDescription = '';

    const uploadedItems = [];
    for (const file of req.files) {
        const itemId = uuidv4();
        const itemUrl = `${BASE_URL}/portfolio_uploads/${file.filename}`;

        dbData.portfolioItems.push({
            id: itemId,
            title: defaultTitle,
            description: defaultDescription,
            category: category || '未分类',
            url: itemUrl,
            filename: file.filename,
            createdAt: new Date().toISOString()
        });
        uploadedItems.push({ itemId, itemUrl });
    }

    await saveData();
    console.log(`${req.files.length} 个作品上传成功，分类: ${category}`);
    res.json({
        code: 0,
        message: 'success',
        uploadedItems: uploadedItems
    });
});

/**
 * 获取作品列表接口
 * GET /portfolio
 * @param {string} category (可选) - 按分类筛选
 */
app.get('/portfolio', (req, res) => {
    const { category } = req.query;
    let filteredItems = dbData.portfolioItems;

    if (category && category !== 'all') {
        filteredItems = filteredItems.filter(item => item.category === category);
    }

    // 按照创建时间倒序排列
    filteredItems.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
        code: 0,
        message: 'success',
        portfolioItems: filteredItems
    });
});

/**
 * 删除作品接口
 * DELETE /portfolio/:id
 */
app.delete('/portfolio/:id', async (req, res) => {
    const { id } = req.params;
    const itemIndex = dbData.portfolioItems.findIndex(item => item.id === id);

    if (itemIndex === -1) {
        return res.status(404).json({ code: 1, message: '作品不存在' });
    }

    const itemToDelete = dbData.portfolioItems[itemIndex];
    const filename = itemToDelete.filename;
    const filePath = path.join(PORTFOLIO_DIR, filename);

    dbData.portfolioItems.splice(itemIndex, 1);

    try {
        await fs.unlink(filePath);
        console.log(`作品 ${id} 及其文件 ${filename} 已删除。`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`文件不存在，可能已被删除: ${filePath}`);
        } else {
            console.error(`删除作品文件失败: ${filePath}, 错误:`, err);
        }
    }
    await saveData();
    res.json({ code: 0, message: '作品删除成功' });
});


// --- 启动服务器 ---
loadData().then(() => {
    app.listen(PORT, () => {
        console.log(`后端服务器运行在 ${BASE_URL}`);
        console.log(`选片图片上传目录: ${UPLOAD_DIR}`);
        console.log(`二维码存储目录: ${QRCODE_DIR}`);
        console.log(`作品集图片上传目录: ${PORTFOLIO_DIR}`);
        console.log(`数据库文件: ${DB_FILE}`);
    });
});