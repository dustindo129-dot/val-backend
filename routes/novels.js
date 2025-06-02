// Main novels router that combines all split modules
import novelRoutes from "./novels/index.js";

export default novelRoutes;

// Export utilities that other modules might need
export { dedupQuery } from "./novels/basic.js";
export { checkAndUnlockContent } from "./novels/contributions.js";
