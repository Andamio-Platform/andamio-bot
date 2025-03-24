FROM node:18-alpine

WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code (excluding .env and other files in .dockerignore)
COPY . .

# Build the application
RUN npm run build

# Command to run the application
CMD ["npm", "run", "start"]