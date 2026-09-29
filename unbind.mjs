
import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('./data/store.db');

db.run("DELETE FROM kv WHERE key='lucky_bind:7027439863'", function(err) {
  if (err) console.log('error:', err);
  else console.log('deleted');
  
  db.all("SELECT * FROM kv WHERE key LIKE 'lucky_bind%'", function(err, rows) {
    console.log('remaining:', rows);
    db.close();
  });
});
