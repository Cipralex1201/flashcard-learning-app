# Flashcard Learning App

A browser-based flashcard learning application designed for efficient vocabulary memorization with audio support and spaced repetition scheduling.

---

# Features

- Flashcard learning interface
- Import flashcards from simple text files
- Text-to-speech (TTS) audio generation
- Multiple language support (Hebrew default, optional English/German)
- Audio playback for pronunciation
- Spaced repetition scheduler
- Similarity-based card comparison to avoid duplicates
- Local database storage
- Simple browser UI
- Works locally without a backend server

---

# Requirements

Before running the project you need:

- Node.js ≥ 18  
- npm  
- A modern browser (Firefox / Chrome)

Check versions:

```bash
node -v
npm -v
```

---

# Installation

Clone or copy the repository first.
Then navigate in it's folder.

```bash
cd flashcard-learning-app
```

Install dependencies:

```bash
npm install
```

---

# Running the Application

Start the development server:

```bash
npm run dev
```

You will see something like:

```text
VITE vX.X.X ready in XXX ms

➜  Local:   http://localhost:5173/
```

Open the displayed URL in your browser.

---

# Project Structure

```text
flashcard-learning-app
│
├── src
│   ├── App.tsx
│   ├── main.tsx
│   ├── db.ts
│   ├── similarity.ts
│   ├── current-scheduler.ts
│   ├── types.ts
│   └── tsv.ts
│
├── public
│   └── audio
│
├── data
│
├── gen-tts.mjs
├── package.json
└── README.md
```

Important components:

| File | Purpose |
|-----|--------|
| App.tsx | Main UI of the application |
| db.ts | Local database logic |
| similarity.ts | Detects similar flashcards |
| current-scheduler.ts | Spaced repetition algorithm |
| tsv.ts | Flashcard parsing |
| gen-tts.mjs | Generates TTS audio files |

---

# Creating Flashcards

Flashcards use a simple format:

```text
term
definition

term
definition

term
definition
```

Example:

```text
kutya
Hund

macska
Katze

ház
Haus
```

Rules:

- Line 1 → term  
- Line 2 → definition  
- Blank line separates cards

---

# Importing Flashcards

1. Open the application  
2. Go to the **Import** screen  
3. Paste or upload the flashcard set  
4. Import them  

The application will automatically:

- parse the cards
- detect similar cards
- insert them into the database

---

# Generating Audio (TTS)

Audio files can be generated with the provided script.

Example:

```bash
node gen-tts.mjs input.txt
```

Language parameter:

```text
--lang=he   Hebrew (default)
--lang=en   English
--lang=de   German
```

Example:

```bash
node gen-tts.mjs words.txt --lang=de
```

Generated audio files are saved to:

```text
public/audio
```

The application automatically uses these audio files when displaying flashcards.

---

# Learning Workflow

Typical workflow:

1. Import flashcards  
2. Start a learning session  
3. Review cards  
4. Rate recall  
5. Scheduler determines next repetition  

The scheduler ensures:

- difficult cards appear more frequently
- easy cards appear less frequently
- long-term retention is improved

---

# Algorithms Used

## Spaced Repetition Scheduler

Implemented in:

```text
current-scheduler.ts
```

Responsible for determining when each flashcard should appear again based on past performance.

---

## Similarity Detection

Implemented in:

```text
similarity.ts
```

Prevents inserting:

- exact duplicates
- very similar flashcards

---

## Text Parsing

Implemented in:

```text
tsv.ts
```

Converts plain text flashcard sets into structured card objects.

---

# Database

Flashcards and learning progress are stored locally in the browser.

Advantages:

- no server required
- offline usage
- instant access

---

# Development

Run development server:

```bash
npm run dev
```

Build production version:

```bash
npm run build
```

Preview production build:

```bash
npm run preview
```

---

# Troubleshooting

If dependencies break after copying the project between computers:

```bash
rm -rf node_modules
npm install
```

Never copy `node_modules` between machines.

---

# License

MIT License

