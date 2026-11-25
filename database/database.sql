-- Select/create your hosted database in your database provider before running this script.

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(120) NOT NULL,
    email VARCHAR(160) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role ENUM('Owner', 'Staff') NOT NULL DEFAULT 'Staff',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_name VARCHAR(120) NOT NULL,
    booking_date DATE NOT NULL,
    booking_time TIME NOT NULL,
    guest_count INT NOT NULL,
    deposit_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    payment_status ENUM('Unpaid', 'Partial', 'Paid') NOT NULL DEFAULT 'Unpaid',
    status ENUM('Confirmed', 'Cancelled') NOT NULL DEFAULT 'Confirmed',
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reservation_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_booking_time (booking_date, booking_time, status)
);

CREATE TABLE IF NOT EXISTS inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_name VARCHAR(120) NOT NULL UNIQUE,
    quantity INT NOT NULL DEFAULT 0,
    low_stock_level INT NOT NULL DEFAULT 5,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_name VARCHAR(120) NOT NULL,
    quantity INT NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    recorded_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sale_user FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    activity VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);


-- VEGETABLE INVENTORY MODULE
CREATE TABLE IF NOT EXISTS vegetables (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    base_unit ENUM('kg', 'g', 'piece', 'bunch') NOT NULL DEFAULT 'kg',
    low_stock_level DECIMAL(12,3) NOT NULL DEFAULT 1.000,
    default_shelf_life_days INT NOT NULL DEFAULT 5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vegetable_batches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vegetable_id INT NOT NULL,
    supplier_name VARCHAR(160) NULL,
    quantity_received DECIMAL(12,3) NOT NULL,
    quantity_remaining DECIMAL(12,3) NOT NULL,
    purchase_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
    received_date DATE NOT NULL,
    expiry_date DATE NOT NULL,
    is_opened TINYINT(1) NOT NULL DEFAULT 0,
    opened_at DATETIME NULL,
    notes VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_veg_batch_vegetable FOREIGN KEY (vegetable_id) REFERENCES vegetables(id) ON DELETE CASCADE,
    INDEX idx_veg_batch_fefo (vegetable_id, expiry_date, quantity_remaining)
);

CREATE TABLE IF NOT EXISTS vegetable_movements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vegetable_id INT NOT NULL,
    batch_id INT NULL,
    movement_type ENUM('DELIVERY', 'USAGE', 'WASTE', 'ADJUSTMENT', 'OPENED') NOT NULL,
    quantity DECIMAL(12,3) NOT NULL,
    reason VARCHAR(160) NULL,
    notes VARCHAR(255) NULL,
    recorded_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_veg_movement_vegetable FOREIGN KEY (vegetable_id) REFERENCES vegetables(id) ON DELETE CASCADE,
    CONSTRAINT fk_veg_movement_batch FOREIGN KEY (batch_id) REFERENCES vegetable_batches(id) ON DELETE SET NULL,
    CONSTRAINT fk_veg_movement_user FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_veg_movement_created (created_at)
);


-- Starter catalog; users can add more vegetables from the application.
INSERT IGNORE INTO vegetables (name, base_unit, low_stock_level, default_shelf_life_days) VALUES
('Carrots', 'kg', 1.000, 7),
('Cabbage', 'kg', 1.000, 7),
('Lettuce', 'kg', 0.500, 4),
('Onions', 'kg', 1.000, 14),
('Tomatoes', 'kg', 1.000, 5),
('Potatoes', 'kg', 1.000, 14),
('Cucumber', 'kg', 0.500, 5),
('Bell Pepper', 'kg', 0.500, 7);
