# Use a specific version of Node.js
FROM node:20.18.3-slim

# Create app directory
WORKDIR /app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./
COPY deploy.sh ./
COPY fix-mongoose.js ./

# Make deploy script executable
RUN chmod +x deploy.sh

# Install dependencies and apply mongoose patch
RUN ./deploy.sh

# Bundle app source
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_OPTIONS="--experimental-specifier-resolution=node"

# Create a health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Expose the port the app runs on
EXPOSE 8080

# Start the application
CMD ["node", "index.js"] 