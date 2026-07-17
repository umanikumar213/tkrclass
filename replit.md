# Attendance Saviour

A web app for TKR College of Engineering & Technology students to check their attendance from the portal using just their roll number.

## How to run

1. Install dependencies (first time only):
   ```
   npm install
   ```

2. Start the server:
   ```
   node server.js
   ```
   The app runs on port 5000 (or whatever `PORT` env var is set to).

3. Open the preview in Replit — it runs via the **Start application** workflow automatically.

## Project structure

| File | Purpose |
|------|---------|
| `server.js` | Express backend — scrapes the TKR portal and exposes a `/login` endpoint |
| `index.html` | Frontend — roll-number input, attendance ring, bunk/simulator calculators |
| `package.json` | Node dependencies: express, axios, cheerio, cors, tough-cookie |

## How it works

1. User enters their roll number.
2. The frontend `POST`s to `/login` on the Express server.
3. The server logs into `http://103.171.190.44/TKRCET` using the roll number as both username and password, scrapes the attendance page with cheerio, and returns a JSON summary.
4. Results are cached for 60 seconds per roll number to avoid hammering the portal.

## User preferences

- Keep the code minimal and readable — no build steps, no frameworks beyond Express.
