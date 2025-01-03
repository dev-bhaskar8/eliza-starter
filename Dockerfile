FROM node:22-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json ./

# Install dependencies with no frozen lockfile
RUN pnpm install --no-frozen-lockfile

# Copy the rest of the application
COPY . .

# Build the application
RUN pnpm build

# Start the bot
CMD ["pnpm", "start", "--characters=characters/norinder.character.json"] 