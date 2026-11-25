// Mizan's own staff (PLATFORM_ADMIN_EMAILS): they also see the platform admin pages.
import { config } from "../config.js";

export const isPlatformAdmin = (email: string) => config.PLATFORM_ADMIN_EMAILS.includes(email.toLowerCase());
