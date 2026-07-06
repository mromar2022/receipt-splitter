# Receipt Splitter

Mobile-friendly receipt and trip expense splitter with local OCR plus optional OpenAI vision extraction.

## Run

```bash
pnpm install
pnpm run dev
```

## Enable AI Receipt Reading

Copy `.env.example` to `.env` and add your key:

```bash
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-5.5
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

The browser never receives the API key. The app calls the local `/api/read-receipt-ai` endpoint, which sends the receipt image to the OpenAI Responses API and returns structured items, taxes, service charges, discounts, and totals.

## Enable Login And Database Save

Create a Supabase project, then run `supabase-schema.sql` in the Supabase SQL Editor. Add these environment variables in Render:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

The app uses Supabase Auth for email/password signup and login. Each signed-in user's trip groups and expenses are saved in the `receipt_splitter_states` table.

For production-style local serving:

```bash
pnpm run build
pnpm run start
```

## Share It Online

Deploy it as a Node web service, not as a static-only site, because `/api/read-receipt-ai` must keep `OPENAI_API_KEY` private on the server.

Recommended Render settings:

```bash
Build Command: pnpm install && pnpm run build
Start Command: pnpm run start
Environment: OPENAI_API_KEY, OPENAI_MODEL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

Render supplies `PORT` automatically. The app listens on that port and serves both the built frontend and AI receipt API.
