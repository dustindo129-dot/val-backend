import express from "express";

// Import all the split modules
import basicRoutes from "./basic.js";
import searchRoutes from "./search.js";
import interactionRoutes from "./interactions.js";
import contributionRoutes from "./contributions.js";
import chaptersLegacyRoutes from "./chaptersLegacy.js";
import realtimeRoutes from "./realtime.js";
import statisticsRoutes from "./statistics.js";

const router = express.Router();

// Use all the split route modules
router.use("/", basicRoutes);
router.use("/", searchRoutes);
router.use("/", interactionRoutes);
router.use("/", contributionRoutes);
router.use("/", chaptersLegacyRoutes);
router.use("/", realtimeRoutes);
router.use("/", statisticsRoutes);

export default router; 