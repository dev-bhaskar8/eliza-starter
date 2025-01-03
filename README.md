# Norinder Mudi Bot

A Twitter bot that parodies the Indian PM's social media presence, featuring:
- Tech enthusiasm
- Love for acronyms
- Ancient Indian wisdom claims
- Digital India initiatives
- Morning yoga updates
- Surprise 8 PM announcements

## Setup

1. Clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/norinder-mudi-bot.git
cd norinder-mudi-bot
```

2. Install dependencies:
```bash
pnpm install
```

3. Create a `.env` file:
```bash
cp .env.example .env
```

4. Add your credentials to `.env`:
```env
OPENROUTER_API_KEY=your_key
TWITTER_USERNAME=your_username
TWITTER_PASSWORD=your_password
TWITTER_EMAIL=your_email
POST_INTERVAL_MIN=6000
POST_INTERVAL_MAX=10000
```

## Running Locally

Development mode:
```bash
pnpm dev
```

Production mode:
```bash
pnpm start --characters="characters/norinder.character.json"
```

## Deployment

### On Render

1. Fork this repository
2. Create a new Web Service on Render
3. Connect your GitHub repository
4. Use the following settings:
   - Build Command: `pnpm install && pnpm build`
   - Start Command: `pnpm start --characters="characters/norinder.character.json"`
5. Add environment variables in Render dashboard

### Using Docker

Build:
```bash
docker build -t norinder-mudi-bot .
```

Run:
```bash
docker run -d --env-file .env norinder-mudi-bot
```

## Rate Limiting

The bot respects API rate limits:
- Minimum 6 seconds between requests
- Maximum 10 requests per minute
- Random intervals between posts

## Credits

Based on the [Eliza](https://github.com/ai16z/eliza) project by ai16z.

## License

MIT License
