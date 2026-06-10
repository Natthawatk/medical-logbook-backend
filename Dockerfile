# Use Node.js LTS (Long Term Support) image
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install --production

# Bundle app source
COPY . .

# Expose the port the app runs on
EXPOSE 5000

# Start the application
CMD [ "node", "server.js" ]
