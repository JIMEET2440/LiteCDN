FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
# Make sure run scripts are executable just in case
CMD ["node", "backend/cdn/cdn.js"]
