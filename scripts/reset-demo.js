// Wipe the OfflineAid database + uploaded floor plans and reseed demo data. (Knowledge index, maps and voice are kept.)
// Stop the server first: start.bat window -> any key.
const fs = require("fs");
const path = require("path");
const data = path.join(__dirname, "..", "data");
for (const f of ["offlineaid.db", "offlineaid.db-wal", "offlineaid.db-shm"]) fs.rmSync(path.join(data, f), { force: true });
fs.rmSync(path.join(data, "uploads"), { recursive: true, force: true });
require("../src/seed").seed();
console.log("Demo data reset. Browser-side queues (IndexedDB) are per device: clear site data in the browser if needed.");
