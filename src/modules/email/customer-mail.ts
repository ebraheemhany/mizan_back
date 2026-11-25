// What every email to a company's customer needs: who it is from, where it goes, the page it links to.
import { config } from "../../config.js";
import { AppError, unauthorized } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { Locale, Sender } from "./templates.js";

/**
 * The company sending, and the user replies go to. Only a confirmed address may
 * receive those replies, so an unconfirmed user can't email customers yet.
 */
export async function customerMailSender(actor: { id: string; companyId: string }): Promise<Sender> {
  const user = await prisma.user.findFirst({
    where: { id: actor.id, companyId: actor.companyId },
    select: { email: true, emailVerifiedAt: true, company: { select: { name: true } } },
  });
  if (!user) throw unauthorized();
  if (!user.emailVerifiedAt) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Confirm your email address before emailing customers");
  }
  return {
    company: user.company.name,
    replyTo: user.email,
  };
}

/** The address typed in, else the customer's (current, then the one on the document). */
export function recipientOf(typed: string | undefined, ...known: (string | null | undefined)[]) {
  const address = typed ?? known.find((value) => !!value);
  if (!address) {
    throw new AppError(400, "NO_CUSTOMER_EMAIL", "The customer has no email address; enter one", { field: "to" });
  }
  return address;
}

/** A page of the app the customer opens without logging in, in the email's language. */
export const customerPageUrl = (locale: Locale, path: string) => new URL(`/${locale}/${path}`, config.APP_URL).toString();
