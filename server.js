require('dotenv').config();
const app = require('./api');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`System is running at http://localhost:${PORT}`));
