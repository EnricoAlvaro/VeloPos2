require('dotenv').config();
require('express-async-errors');

const express = require('express');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();

const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
    console.warn(`Missing environment variables: ${missingEnv.join(', ')}`);
}

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    queueLimit: 0,
    dateStrings: true,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/'
};

function createToken(user) {
    if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured.');
    return jwt.sign({
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role
    }, JWT_SECRET, { expiresIn: '8h' });
}

function setAuthCookie(res, user) {
    res.cookie('auth_token', createToken(user), COOKIE_OPTIONS);
}

function requireLogin(req, res, next) {
    const token = req.cookies && req.cookies.auth_token;
    if (!token) return res.status(401).json({ message: 'Please sign in first.' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Your login has expired. Please sign in again.' });
    }
}

function requireOwner(req, res, next) {
    if (!req.user || req.user.role !== 'Owner') {
        return res.status(403).json({ message: 'Only the Owner can access this page.' });
    }
    return next();
}

async function logActivity(userId, message) {
    await db.execute(
        'INSERT INTO activity_logs (user_id, activity) VALUES (?, ?)',
        [userId || null, message]
    );
}

// SIGN UP: the first registered account becomes the Owner.
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { fullName, email, password } = req.body;
        if (!fullName || !email || !password) {
            return res.status(400).json({ message: 'Please complete all fields.' });
        }
        if (String(password).length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters.' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
        if (existing.length) {
            return res.status(409).json({ message: 'That email is already registered.' });
        }

        const [countRows] = await db.execute('SELECT COUNT(*) AS total FROM users');
        const role = Number(countRows[0].total) === 0 ? 'Owner' : 'Staff';
        const hashedPassword = await bcrypt.hash(String(password), 10);
        const [result] = await db.execute(
            'INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, ?)',
            [String(fullName).trim(), normalizedEmail, hashedPassword, role]
        );

        const user = { id: result.insertId, fullName: String(fullName).trim(), email: normalizedEmail, role };
        setAuthCookie(res, user);
        await logActivity(user.id, 'Created an account');
        return res.status(201).json({ message: `Account created. Your role is ${role}.`, user });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'That email is already registered.' });
        }
        console.error('Signup error:', error);
        return res.status(500).json({ message: 'Could not create account. Check your database connection and tables.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = String(email || '').trim().toLowerCase();
        const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
        if (!rows.length) return res.status(401).json({ message: 'Incorrect email or password.' });

        const validPassword = await bcrypt.compare(String(password || ''), rows[0].password);
        if (!validPassword) return res.status(401).json({ message: 'Incorrect email or password.' });

        const user = {
            id: rows[0].id,
            fullName: rows[0].full_name,
            email: rows[0].email,
            role: rows[0].role
        };
        setAuthCookie(res, user);
        await logActivity(user.id, 'Signed in');
        return res.json({ message: 'Welcome back!', user });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: 'Could not sign in. Check your database connection.' });
    }
});

app.post('/api/auth/logout', requireLogin, async (req, res) => {
    try {
        await logActivity(req.user.id, 'Signed out');
        res.clearCookie('auth_token', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/'
        });
        return res.json({ message: 'Signed out successfully.' });
    } catch (error) {
        console.error('Logout error:', error);
        return res.status(500).json({ message: 'Could not sign out.' });
    }
});

app.get('/api/auth/me', (req, res) => {
    const token = req.cookies && req.cookies.auth_token;
    if (!token) return res.json({ user: null });
    try {
        const user = jwt.verify(token, JWT_SECRET);
        return res.json({
            user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role }
        });
    } catch (error) {
        res.clearCookie('auth_token', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/'
        });
        return res.json({ user: null });
    }
});

// DASHBOARD SUMMARY
app.get('/api/dashboard', requireLogin, async (req, res) => {
    try {
        const [[booking]] = await db.execute("SELECT COUNT(*) AS total FROM reservations WHERE status = 'Confirmed'");
        const [[sales]] = await db.execute('SELECT COALESCE(SUM(total_amount), 0) AS total FROM sales WHERE DATE(created_at) = CURDATE()');
        const [[stock]] = await db.execute('SELECT COUNT(*) AS total FROM inventory');
        const [[low]] = await db.execute('SELECT COUNT(*) AS total FROM inventory WHERE quantity <= low_stock_level');
        const [activities] = await db.execute(
            'SELECT activity, created_at FROM activity_logs ORDER BY id DESC LIMIT 8'
        );
        res.json({ reservations: booking.total, salesToday: sales.total, inventoryItems: stock.total, lowStock: low.total, activities });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Could not load dashboard.' }); }
});

// RESERVATIONS
app.get('/api/reservations', requireLogin, async (req, res) => {
    const [rows] = await db.execute('SELECT * FROM reservations ORDER BY booking_date DESC, booking_time DESC');
    res.json(rows);
});

app.post('/api/reservations', requireLogin, async (req, res) => {
    try {
        const { customerName, bookingDate, bookingTime, guestCount, depositAmount, paymentStatus } = req.body;
        if (!customerName || !bookingDate || !bookingTime || Number(guestCount) < 1) return res.status(400).json({ message: 'Please complete the reservation details.' });
        const [conflicts] = await db.execute(
            "SELECT id FROM reservations WHERE booking_date = ? AND booking_time = ? AND status = 'Confirmed'",
            [bookingDate, bookingTime]
        );
        if (conflicts.length) return res.status(409).json({ message: 'That date and time are already booked. Please choose another slot.' });
        const [result] = await db.execute(
            'INSERT INTO reservations (customer_name, booking_date, booking_time, guest_count, deposit_amount, payment_status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [customerName.trim(), bookingDate, bookingTime, Number(guestCount), Number(depositAmount || 0), paymentStatus || 'Unpaid', req.user.id]
        );
        await logActivity(req.user.id, `Added reservation #${result.insertId}`);
        res.status(201).json({ message: 'Reservation added.' });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Could not save reservation.' }); }
});

app.put('/api/reservations/:id', requireLogin, async (req, res) => {
    try {
        const { customerName, bookingDate, bookingTime, guestCount, depositAmount, paymentStatus } = req.body;
        const [conflicts] = await db.execute(
            "SELECT id FROM reservations WHERE booking_date = ? AND booking_time = ? AND status = 'Confirmed' AND id <> ?",
            [bookingDate, bookingTime, req.params.id]
        );
        if (conflicts.length) return res.status(409).json({ message: 'That date and time are already booked.' });
        await db.execute(
            'UPDATE reservations SET customer_name=?, booking_date=?, booking_time=?, guest_count=?, deposit_amount=?, payment_status=? WHERE id=?',
            [customerName, bookingDate, bookingTime, Number(guestCount), Number(depositAmount), paymentStatus, req.params.id]
        );
        await logActivity(req.user.id, `Updated reservation #${req.params.id}`);
        res.json({ message: 'Reservation updated.' });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Could not update reservation.' }); }
});

app.patch('/api/reservations/:id/cancel', requireLogin, async (req, res) => {
    await db.execute("UPDATE reservations SET status='Cancelled' WHERE id=?", [req.params.id]);
    await logActivity(req.user.id, `Cancelled reservation #${req.params.id}`);
    res.json({ message: 'Reservation cancelled.' });
});

// INVENTORY
app.get('/api/inventory', requireLogin, async (req, res) => {
    const [rows] = await db.execute('SELECT * FROM inventory ORDER BY item_name');
    res.json(rows);
});

app.post('/api/inventory', requireLogin, async (req, res) => {
    try {
        const { itemName, quantity, lowStockLevel } = req.body;
        if (!itemName || Number(quantity) < 0 || Number(lowStockLevel) < 0) return res.status(400).json({ message: 'Enter valid inventory details.' });
        await db.execute('INSERT INTO inventory (item_name, quantity, low_stock_level) VALUES (?, ?, ?)', [itemName.trim(), Number(quantity), Number(lowStockLevel)]);
        await logActivity(req.user.id, `Added inventory item: ${itemName.trim()}`);
        res.status(201).json({ message: 'Inventory item added.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That inventory item already exists.' });
        console.error(error); res.status(500).json({ message: 'Could not add inventory item.' });
    }
});

app.put('/api/inventory/:id', requireLogin, async (req, res) => {
    const { itemName, quantity, lowStockLevel } = req.body;
    try {
        await db.execute('UPDATE inventory SET item_name=?, quantity=?, low_stock_level=? WHERE id=?', [itemName.trim(), Number(quantity), Number(lowStockLevel), req.params.id]);
        await logActivity(req.user.id, `Updated inventory item #${req.params.id}`);
        res.json({ message: 'Inventory updated.' });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Could not update inventory.' }); }
});

app.delete('/api/inventory/:id', requireLogin, async (req, res) => {
    await db.execute('DELETE FROM inventory WHERE id=?', [req.params.id]);
    await logActivity(req.user.id, `Deleted inventory item #${req.params.id}`);
    res.json({ message: 'Inventory item deleted.' });
});

// SALES: if the sold item matches an inventory item, its stock is deducted.
app.get('/api/sales', requireLogin, async (req, res) => {
    const [rows] = await db.execute('SELECT sales.*, users.full_name AS recorded_by_name FROM sales LEFT JOIN users ON sales.recorded_by=users.id ORDER BY sales.id DESC');
    res.json(rows);
});

app.post('/api/sales', requireLogin, async (req, res) => {
    const { itemName, quantity, unitPrice } = req.body;
    const qty = Number(quantity);
    const price = Number(unitPrice);
    if (!itemName || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(price) || price <= 0) return res.status(400).json({ message: 'Enter a valid item, quantity, and price.' });
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [items] = await connection.execute('SELECT * FROM inventory WHERE LOWER(item_name)=LOWER(?) FOR UPDATE', [itemName.trim()]);
        if (items.length && items[0].quantity < qty) {
            await connection.rollback();
            return res.status(400).json({ message: `Not enough stock. Available quantity: ${items[0].quantity}.` });
        }
        if (items.length) await connection.execute('UPDATE inventory SET quantity = quantity - ? WHERE id = ?', [qty, items[0].id]);
        const total = qty * price;
        await connection.execute('INSERT INTO sales (item_name, quantity, unit_price, total_amount, recorded_by) VALUES (?, ?, ?, ?, ?)', [itemName.trim(), qty, price, total, req.user.id]);
        await connection.commit();
        await logActivity(req.user.id, `Recorded a sale: ${itemName.trim()}`);
        res.status(201).json({ message: 'Sale recorded.', total });
    } catch (error) {
        await connection.rollback(); console.error(error); res.status(500).json({ message: 'Could not record sale.' });
    } finally { connection.release(); }
});

// VEGETABLE INVENTORY: delivery batches, FEFO usage, opening and waste tracking.
app.get('/api/vegetables', requireLogin, async (req, res) => {
    try {
        const [vegetables] = await db.execute(`
            SELECT v.id, v.name, v.base_unit, v.low_stock_level, v.default_shelf_life_days,
                   COALESCE(SUM(CASE WHEN b.expiry_date >= CURDATE() THEN b.quantity_remaining ELSE 0 END), 0) AS usable_stock,
                   COALESCE(SUM(b.quantity_remaining), 0) AS total_stock
            FROM vegetables v LEFT JOIN vegetable_batches b ON b.vegetable_id = v.id
            GROUP BY v.id ORDER BY v.name`);
        const [batches] = await db.execute(`
            SELECT b.*, v.name AS vegetable_name, v.base_unit
            FROM vegetable_batches b JOIN vegetables v ON v.id = b.vegetable_id
            WHERE b.quantity_remaining > 0 ORDER BY b.expiry_date ASC, b.id ASC`);
        const [alerts] = await db.execute(`
            SELECT v.name, v.base_unit, b.id AS batch_id, b.quantity_remaining, b.expiry_date,
                   CASE WHEN b.expiry_date < CURDATE() THEN 'Expired'
                        WHEN b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 2 DAY) THEN 'Near expiry'
                        ELSE 'In stock' END AS alert_type
            FROM vegetable_batches b JOIN vegetables v ON v.id = b.vegetable_id
            WHERE b.quantity_remaining > 0 AND (b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 2 DAY))
            ORDER BY b.expiry_date ASC`);
        res.json({ vegetables, batches, alerts });
    } catch (error) {
        console.error('Vegetable inventory load error:', error);
        res.status(500).json({ message: 'Could not load vegetable inventory. Make sure the vegetable tables are imported.' });
    }
});

app.post('/api/vegetables/catalog', requireLogin, async (req, res) => {
    try {
        const { name, baseUnit = 'kg', lowStockLevel = 1, shelfLifeDays = 5 } = req.body;
        const allowedUnits = ['kg', 'g', 'piece', 'bunch'];
        if (!name || !allowedUnits.includes(baseUnit) || Number(lowStockLevel) < 0 || !Number.isInteger(Number(shelfLifeDays)) || Number(shelfLifeDays) < 1) {
            return res.status(400).json({ message: 'Enter a valid vegetable name, unit, stock level, and shelf life.' });
        }
        await db.execute(
            'INSERT INTO vegetables (name, base_unit, low_stock_level, default_shelf_life_days) VALUES (?, ?, ?, ?)',
            [String(name).trim(), baseUnit, Number(lowStockLevel), Number(shelfLifeDays)]
        );
        await logActivity(req.user.id, `Added vegetable: ${String(name).trim()}`);
        res.status(201).json({ message: 'Vegetable added to catalog.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That vegetable is already in the catalog.' });
        console.error(error);
        res.status(500).json({ message: 'Could not add vegetable.' });
    }
});

app.post('/api/vegetables/deliveries', requireLogin, async (req, res) => {
    const { vegetableId, supplierName, quantity, purchaseCost, receivedDate, expiryDate, notes } = req.body;
    const qty = Number(quantity);
    const cost = Number(purchaseCost || 0);
    if (!vegetableId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost < 0 || !receivedDate || !expiryDate || expiryDate < receivedDate) {
        return res.status(400).json({ message: 'Enter valid delivery quantity, cost, received date, and expiry date.' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [veg] = await connection.execute('SELECT id FROM vegetables WHERE id = ?', [vegetableId]);
        if (!veg.length) { await connection.rollback(); return res.status(404).json({ message: 'Vegetable not found.' }); }
        const [result] = await connection.execute(
            `INSERT INTO vegetable_batches (vegetable_id, supplier_name, quantity_received, quantity_remaining, purchase_cost, received_date, expiry_date, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [vegetableId, supplierName || null, qty, qty, cost, receivedDate, expiryDate, notes || null]
        );
        await connection.execute(
            `INSERT INTO vegetable_movements (vegetable_id, batch_id, movement_type, quantity, reason, notes, recorded_by)
             VALUES (?, ?, 'DELIVERY', ?, 'Supplier delivery', ?, ?)`,
            [vegetableId, result.insertId, qty, notes || null, req.user.id]
        );
        await connection.commit();
        await logActivity(req.user.id, `Recorded vegetable delivery batch #${result.insertId}`);
        res.status(201).json({ message: 'Delivery batch recorded.', batchId: result.insertId });
    } catch (error) {
        await connection.rollback(); console.error(error);
        res.status(500).json({ message: 'Could not record delivery.' });
    } finally { connection.release(); }
});

app.post('/api/vegetables/use', requireLogin, async (req, res) => {
    const { vegetableId, quantity, reason = 'Preparation', notes, openedExpiryDate } = req.body;
    const requested = Number(quantity);
    if (!vegetableId || !Number.isFinite(requested) || requested <= 0) return res.status(400).json({ message: 'Enter a valid vegetable and quantity.' });
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [batches] = await connection.execute(
            `SELECT * FROM vegetable_batches WHERE vegetable_id = ? AND quantity_remaining > 0 AND expiry_date >= CURDATE()
             ORDER BY expiry_date ASC, id ASC FOR UPDATE`, [vegetableId]);
        const available = batches.reduce((sum, batch) => sum + Number(batch.quantity_remaining), 0);
        if (available + 0.000001 < requested) {
            await connection.rollback();
            return res.status(400).json({ message: `Not enough usable stock. Available: ${available.toFixed(3)}.` });
        }
        let remaining = requested;
        const deductions = [];
        for (const batch of batches) {
            if (remaining <= 0.000001) break;
            const current = Number(batch.quantity_remaining);
            const used = Math.min(current, remaining);
            const newBalance = Number((current - used).toFixed(3));
            await connection.execute('UPDATE vegetable_batches SET quantity_remaining = ? WHERE id = ?', [newBalance, batch.id]);
            await connection.execute(
                `INSERT INTO vegetable_movements (vegetable_id, batch_id, movement_type, quantity, reason, notes, recorded_by)
                 VALUES (?, ?, 'USAGE', ?, ?, ?, ?)`,
                [vegetableId, batch.id, used, reason, notes || null, req.user.id]);
     
            if (openedExpiryDate && newBalance > 0 && used > 0) {
                if (openedExpiryDate < new Date().toISOString().slice(0, 10) || openedExpiryDate > String(batch.expiry_date).slice(0, 10)) {
                    throw new Error('Opened expiry date must be today or later and cannot be later than the original expiry date.');
                }
                await connection.execute(
                    'UPDATE vegetable_batches SET is_opened = 1, opened_at = COALESCE(opened_at, NOW()), expiry_date = ? WHERE id = ?',
                    [openedExpiryDate, batch.id]);
                await connection.execute(
                    `INSERT INTO vegetable_movements (vegetable_id, batch_id, movement_type, quantity, reason, notes, recorded_by)
                     VALUES (?, ?, 'OPENED', 0, 'Batch cut/opened; remaining stock retained', ?, ?)`,
                    [vegetableId, batch.id, `Shortened expiry to ${openedExpiryDate}`, req.user.id]);
            }
            deductions.push({ batchId: batch.id, used, remaining: newBalance });
            remaining = Number((remaining - used).toFixed(3));
        }
        await connection.commit();
        await logActivity(req.user.id, `Used ${requested.toFixed(3)} vegetable units for ${reason}`);
        res.json({ message: 'Vegetable usage recorded using FEFO.', deductions });
    } catch (error) {
        await connection.rollback(); console.error(error);
        res.status(400).json({ message: error.message || 'Could not record vegetable usage.' });
    } finally { connection.release(); }
});

app.post('/api/vegetables/batches/:id/open', requireLogin, async (req, res) => {
    const { openedExpiryDate } = req.body;
    if (!openedExpiryDate) return res.status(400).json({ message: 'Provide the shortened expiry date.' });
    try {
        const [rows] = await db.execute('SELECT * FROM vegetable_batches WHERE id = ? AND quantity_remaining > 0', [req.params.id]);
        if (!rows.length) return res.status(404).json({ message: 'Active batch not found.' });
        const batch = rows[0];
        if (openedExpiryDate < new Date().toISOString().slice(0, 10) || openedExpiryDate > String(batch.expiry_date).slice(0, 10)) {
            return res.status(400).json({ message: 'New expiry must be today or later and cannot be later than the original expiry.' });
        }
        await db.execute('UPDATE vegetable_batches SET is_opened=1, opened_at=COALESCE(opened_at, NOW()), expiry_date=? WHERE id=?', [openedExpiryDate, req.params.id]);
        await db.execute(
            `INSERT INTO vegetable_movements (vegetable_id, batch_id, movement_type, quantity, reason, notes, recorded_by)
             VALUES (?, ?, 'OPENED', 0, 'Batch cut/opened', ?, ?)`,
            [batch.vegetable_id, batch.id, `Shortened expiry to ${openedExpiryDate}`, req.user.id]);
        await logActivity(req.user.id, `Marked vegetable batch #${batch.id} as cut/opened`);
        res.json({ message: 'Batch marked as cut/opened. Remaining stock stays in inventory.' });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Could not update opened batch.' }); }
});

app.post('/api/vegetables/waste', requireLogin, async (req, res) => {
    const { vegetableId, quantity, wasteType, notes } = req.body;
    const requested = Number(quantity);
    const allowedWaste = ['Spoilage / rot', 'Peeling', 'Trimming', 'Discarded portion', 'Other'];
    if (!vegetableId || !Number.isFinite(requested) || requested <= 0 || !allowedWaste.includes(wasteType)) {
        return res.status(400).json({ message: 'Enter a valid vegetable, waste quantity, and waste type.' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [batches] = await connection.execute(
            `SELECT * FROM vegetable_batches WHERE vegetable_id=? AND quantity_remaining>0 ORDER BY expiry_date ASC, id ASC FOR UPDATE`,
            [vegetableId]);
        const available = batches.reduce((sum, batch) => sum + Number(batch.quantity_remaining), 0);
        if (available + 0.000001 < requested) {
            await connection.rollback();
            return res.status(400).json({ message: `Not enough stock to record waste. Available: ${available.toFixed(3)}.` });
        }
        let remaining = requested;
        for (const batch of batches) {
            if (remaining <= 0.000001) break;
            const amount = Math.min(Number(batch.quantity_remaining), remaining);
            const balance = Number((Number(batch.quantity_remaining) - amount).toFixed(3));
            await connection.execute('UPDATE vegetable_batches SET quantity_remaining=? WHERE id=?', [balance, batch.id]);
            await connection.execute(
                `INSERT INTO vegetable_movements (vegetable_id, batch_id, movement_type, quantity, reason, notes, recorded_by)
                 VALUES (?, ?, 'WASTE', ?, ?, ?, ?)`,
                [vegetableId, batch.id, amount, wasteType, notes || null, req.user.id]);
            remaining = Number((remaining - amount).toFixed(3));
        }
        await connection.commit();
        await logActivity(req.user.id, `Recorded ${requested.toFixed(3)} vegetable units as ${wasteType}`);
        res.json({ message: 'Vegetable waste recorded.' });
    } catch (error) {
        await connection.rollback(); console.error(error);
        res.status(500).json({ message: 'Could not record vegetable waste.' });
    } finally { connection.release(); }
});

app.get('/api/vegetables/movements', requireLogin, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT m.*, v.name AS vegetable_name, v.base_unit, b.expiry_date
            FROM vegetable_movements m JOIN vegetables v ON v.id=m.vegetable_id
            LEFT JOIN vegetable_batches b ON b.id=m.batch_id
            ORDER BY m.id DESC LIMIT 100`);
        res.json(rows);
    } catch (error) { console.error(error); res.status(500).json({ message: 'Could not load vegetable movement history.' }); }
});

app.get('/api/reports', requireLogin, async (req, res) => {
    const period = req.query.period || 'today';
    let condition = 'DATE(created_at) = CURDATE()';
    if (period === 'week') condition = 'created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    if (period === 'month') condition = 'YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE())';
    const [sales] = await db.execute(`SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS transactions FROM sales WHERE ${condition}`);
    let bookingCondition = 'booking_date = CURDATE()';
    if (period === 'week') bookingCondition = 'booking_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND booking_date <= CURDATE()';
    if (period === 'month') bookingCondition = 'YEAR(booking_date)=YEAR(CURDATE()) AND MONTH(booking_date)=MONTH(CURDATE())';
    const [bookings] = await db.execute(`SELECT COUNT(*) AS total FROM reservations WHERE ${bookingCondition} AND status='Confirmed'`);
    res.json({ totalSales: sales[0].total, transactions: sales[0].transactions, bookings: bookings[0].total, period });
});

app.get('/api/users', requireOwner, async (req, res) => {
    const [users] = await db.execute('SELECT id, full_name, email, role, created_at FROM users ORDER BY id');
    const [logs] = await db.execute('SELECT activity_logs.activity, activity_logs.created_at, users.full_name FROM activity_logs LEFT JOIN users ON activity_logs.user_id=users.id ORDER BY activity_logs.id DESC LIMIT 50');
    res.json({ users, logs });
});

app.use((error, req, res, next) => {
    console.error('API error:', error);
    if (res.headersSent) return next(error);
    return res.status(500).json({ message: 'An unexpected server error occurred.' });
});

module.exports = app;
