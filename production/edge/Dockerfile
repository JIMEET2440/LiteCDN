FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --production

# Expose ports based on ENV (usually 80 or 443 in production)
EXPOSE 80

COPY . .

# Run the global edge server 
CMD ["npm", "start"]