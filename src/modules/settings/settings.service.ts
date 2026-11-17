import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { integrationsSection, notificationsSection, type UpdateSettingsInput } from "./settings.schemas.js";

const settingsSelect = {
  name: true,
  taxNumber: true,
  commercialRegister: true,
  phone: true,
  address: true,
  currency: true,
  vatEnabled: true,
  withholdingEnabled: true,
  fiscalStartMonth: true,
  invoicePrefix: true,
  invoiceNextNumber: true,
  quotePrefix: true,
  quoteNextNumber: true,
  paymentTermsDays: true,
  invoiceTemplate: true,
  invoiceFooter: true,
  notifications: true,
  integrations: true,
} satisfies Prisma.CompanySelect;

type SettingsRow = Prisma.CompanyGetPayload<{ select: typeof settingsSelect }>;

/** Database row -> the sections the settings page works with. */
function toDto(row: SettingsRow) {
  return {
    company: {
      name: row.name,
      taxNumber: row.taxNumber,
      commercialRegister: row.commercialRegister,
      phone: row.phone,
      address: row.address,
    },
    taxes: {
      vatEnabled: row.vatEnabled,
      withholdingEnabled: row.withholdingEnabled,
      currency: row.currency,
      fiscalStartMonth: row.fiscalStartMonth,
    },
    numbering: {
      invoicePrefix: row.invoicePrefix,
      invoiceNext: row.invoiceNextNumber,
      quotePrefix: row.quotePrefix,
      quoteNext: row.quoteNextNumber,
      paymentTermsDays: row.paymentTermsDays,
    },
    template: { style: row.invoiceTemplate, footer: row.invoiceFooter },
    // Parsed so a switch added later shows up with its default instead of missing.
    notifications: { ...notificationsDefaults, ...(row.notifications as object) },
    integrations: { ...integrationsDefaults, ...(row.integrations as object) },
  };
}

export type SettingsDto = ReturnType<typeof toDto>;

const notificationsDefaults = notificationsSection.parse({
  overdueInvoice: true,
  newPayment: true,
  taskReminder: true,
  weeklyDigest: false,
});
const integrationsDefaults = integrationsSection.parse({
  whatsapp: false,
  paymentGateway: false,
  eta: false,
  calendar: false,
});

export async function getSettings(companyId: string) {
  const row = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: settingsSelect });
  return toDto(row);
}

/** Saves the sections that were sent; the others stay as they are. */
export async function updateSettings(companyId: string, input: UpdateSettingsInput) {
  const data: Prisma.CompanyUpdateInput = {};

  if (input.company) {
    data.name = input.company.name;
    data.taxNumber = input.company.taxNumber;
    data.commercialRegister = input.company.commercialRegister;
    data.phone = input.company.phone;
    data.address = input.company.address;
  }
  if (input.taxes) {
    data.vatEnabled = input.taxes.vatEnabled;
    data.withholdingEnabled = input.taxes.withholdingEnabled;
    data.currency = input.taxes.currency;
    data.fiscalStartMonth = input.taxes.fiscalStartMonth;
  }
  if (input.numbering) {
    // Once invoices exist, a next number that is already used will be refused.
    data.invoicePrefix = input.numbering.invoicePrefix;
    data.invoiceNextNumber = input.numbering.invoiceNext;
    data.quotePrefix = input.numbering.quotePrefix;
    data.quoteNextNumber = input.numbering.quoteNext;
    data.paymentTermsDays = input.numbering.paymentTermsDays;
  }
  if (input.template) {
    data.invoiceTemplate = input.template.style;
    data.invoiceFooter = input.template.footer;
  }
  if (input.notifications) data.notifications = input.notifications;
  if (input.integrations) data.integrations = input.integrations;

  const row = await prisma.company.update({ where: { id: companyId }, data, select: settingsSelect });
  return toDto(row);
}
