// Import route handlers
import novelRoutes from "./routes/novels.js";
import userRoutes from "./routes/users.js";
import authRoutes from "./routes/auth.js";
import commentRoutes from "./routes/comments.js";
import moduleRoutes from "./routes/modules.js";
import express from "express";
import cors from "cors";
import donationRoutes from './routes/donation.js';
import reportRoutes from './routes/reports.js';

// Initialize Express application
const app = express();

// Enable CORS for cross-origin requests
app.use(
  cors({
    origin: ["https://valvrareteam.netlify.app", "http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse JSON request bodies with a 10MB size limit
// This is needed for handling large image uploads
app.use(express.json({ limit: "10mb" }));

// Parse URL-encoded request bodies with a 10MB size limit
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Register API routes
// Each route is prefixed with /api for versioning and organization
app.use("/api/auth", authRoutes); // Authentication routes (login, register, etc.)
app.use("/api/novels", novelRoutes); // Novel management routes
app.use("/api/comments", commentRoutes); // Comment system routes
app.use("/api/users", userRoutes); // User profile and management routes
app.use("/api", moduleRoutes); // Module management routes (mounted at root /api)
app.use('/api/donation', donationRoutes);
app.use('/api/reports', reportRoutes);
