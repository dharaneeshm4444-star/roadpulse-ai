# RoadPulse — AI-Based Road Problem Detection and Reporting

**Track:** CoE Growth Capstone — Project Better Tomorrow (Pathway B: Fresh Discovery)
**Type:** Software
**Status:** Review 1 — approx. 35% complete

## Problem statement

Commuters encounter road damage (potholes, cracks, waterlogging, debris, faded
markings, damaged signage) daily, but there is no lightweight way for an
ordinary person to flag it and have it tracked to resolution. RoadPulse lets
someone photograph a road surface, get an instant automated flag on likely
damage, and log it into a trackable civic report.

## What's completed so far

- Full working front-end prototype (React + Vite)
- **Detection engine (v1, heuristic-based):** the uploaded image is scaled
  down, converted to grayscale, and divided into a grid. Each cell's
  brightness and local variance are compared against the image's overall
  average. Cells that are notably darker *and* texturally noisy (a proxy for
  shadowed, broken asphalt) are flagged as anomalies, clustered into blobs via
  flood-fill, and drawn as bounding boxes on the image with a confidence
  score.
- **Reporting flow:** category (7 types), severity (Low/Medium/High,
  auto-suggested from blob size but user-adjustable), location (manual entry
  or device geolocation), and free-text notes.
- **Tracking dashboard:** category and severity breakdown charts, a
  filterable report log, and a status lifecycle (Reported → Verified →
  Resolved) per report.
- **Persistence:** reports are saved to browser `localStorage` so data
  survives a refresh.

## What's currently working

- End-to-end flow: upload photo → automated analysis → bounding-box overlay
  → confirm/edit details → log report → see it reflected in the dashboard
  and charts.
- Filtering the report log by category and status.
- Status cycling and deleting individual reports.

## Honest limitation (by design at this stage)

The current detector is a **rule-based heuristic**, not a trained machine
learning model. It's a deliberate placeholder used to validate the full
product flow (capture → analyze → report → track) before investing in a real
model. It is reasonably good at flagging dark, high-texture regions typical
of potholes/cracks in daylight photos, but it will misfire on shadows, wet
patches, or low-contrast damage, and has no notion of image classes beyond
"anomaly present or not."

## Pending work / next steps

1. Replace the heuristic detector with a trained CNN (e.g. a fine-tuned
   YOLOv8 or MobileNet classifier) on a labeled pothole/road-damage dataset.
2. Real map integration (e.g. Leaflet/Google Maps) instead of a plain text
   location field.
3. Backend + database so reports persist beyond a single browser
   (currently `localStorage`-only).
4. Multi-user support and a simple authority/admin view for verifying and
   resolving reports.
5. Field validation: re-test with at least 3 real users on real road photos
   and collect feedback per the Prototype & Validation Report requirement.

## Tech stack

- React 18 + Vite
- Recharts (dashboard charts)
- lucide-react (icons)
- Canvas API for client-side image analysis
- Browser Geolocation API

## Running locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually `http://localhost:5173`).
