import mongoose from 'mongoose';
import Gift from '../models/Gift.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const defaultGifts = [
  {
    name: 'Hoa anh đào',
    icon: '🌸',
    price: 10,
    order: 1
  },
  {
    name: 'Cà phê',
    icon: '☕',
    price: 50,
    order: 2
  },
  {
    name: 'Bánh ngọt',
    icon: '🍰',
    price: 100,
    order: 3
  },
  {
    name: 'Gấu bông',
    icon: '🧸',
    price: 500,
    order: 4
  },
  {
    name: 'Kim cương',
    icon: '💎',
    price: 1000,
    order: 5
  }
];

async function initializeGifts() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Check if gifts already exist
    const existingGifts = await Gift.find();
    if (existingGifts.length > 0) {
      console.log('Gifts already exist in database. Skipping initialization.');
      return;
    }

    // Insert default gifts
    await Gift.insertMany(defaultGifts);
    console.log('Default gifts initialized successfully!');

    // Display the created gifts
    const gifts = await Gift.find().sort({ order: 1 });
    console.log('\nCreated gifts:');
    gifts.forEach(gift => {
      console.log(`${gift.icon} ${gift.name} - ${gift.price} 🌾`);
    });

  } catch (error) {
    console.error('Error initializing gifts:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the initialization
initializeGifts(); 