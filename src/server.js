require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { initDB } = require('./db');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', require('./routes'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

async function main() {
  initDB();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`Nexus Panel running on port ${PORT}`);
  });
}

main();
