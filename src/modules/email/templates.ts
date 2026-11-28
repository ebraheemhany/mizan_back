// The emails Mizan sends, in Arabic and English. Every value that comes from a
// user (names, messages, company details) is escaped before it goes in the HTML.
import type { Mail } from "../../lib/mailer.js";

export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];

const BRAND = "#047857";

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function formatMoney(locale: Locale, amount: string | number, currency: string) {
  const value = Number(amount);
  const tag = locale === "ar" ? "ar-EG-u-nu-latn" : "en-US";
  try {
    return new Intl.NumberFormat(tag, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  } catch {
    // Not an ISO currency code.
    return `${new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(value)} ${currency}`;
  }
}

/** A YYYY-MM-DD date as "21 ديسمبر 2026" / "21 December 2026". */
export function formatDate(locale: Locale, iso: string) {
  const tag = locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
  return new Intl.DateTimeFormat(tag, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Content = {
  locale: Locale;
  /** The line inbox lists show after the subject. */
  preview: string;
  /** Shown at the top: Mizan, on every email. */
  senderName: string;
  heading: string;
  /** Plain text; blank lines start a new paragraph. */
  paragraphs: string[];
  /** Label and value rows in a box (invoice number, amount...). */
  facts?: [string, string][];
  button?: { label: string; url: string };
  /** Small print under the button. */
  notes?: string[];
  footer: string;
};

function render(c: Content): Pick<Mail, "html" | "text"> {
  const rtl = c.locale === "ar";
  const dir = rtl ? "rtl" : "ltr";
  const align = rtl ? "right" : "left";
  const t = TEXT[c.locale];

  const paragraph = (text: string) =>
    text
      .trim()
      .split(/\n{2,}/)
      .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`)
      .join("");

  const brand = `<p style="margin:0;font-size:18px;font-weight:bold;color:${BRAND}">${esc(c.senderName)}</p>`;

  const facts = c.facts?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;background:#f6f8f7;border-radius:12px">${c.facts
        .map(
          ([label, value]) =>
            `<tr><td style="padding:10px 16px;color:#5f6f69;font-size:14px">${esc(label)}</td><td style="padding:10px 16px;font-weight:bold;font-size:14px;text-align:${rtl ? "left" : "right"}" dir="auto">${esc(value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";

  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td style="border-radius:10px;background:${BRAND}"><a href="${esc(c.button.url)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-weight:bold;font-size:15px;text-decoration:none">${esc(c.button.label)}</a></td></tr></table>`
    : "";

  const notes = [
    ...(c.notes ?? []),
    ...(c.button ? [t.linkFallback] : []),
  ];
  const small = notes.length
    ? `<div style="font-size:13px;line-height:1.7;color:#5f6f69">${notes.map((n) => `<p style="margin:0 0 8px">${esc(n)}</p>`).join("")}${
        c.button ? `<p style="margin:0 0 8px;word-break:break-all" dir="ltr"><a href="${esc(c.button.url)}" style="color:${BRAND}">${esc(c.button.url)}</a></p>` : ""
      }</div>`
    : "";

  const html = `<!doctype html>
<html lang="${c.locale}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f4f3">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4f3;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="max-width:560px;background:#ffffff;border:1px solid #e2e8e5;border-radius:16px;font-family:Tahoma,Arial,sans-serif;color:#1c2925;text-align:${align}">
<tr><td style="padding:28px 28px 6px">
${brand}
<h1 style="margin:20px 0 14px;font-size:20px;line-height:1.5;color:#0f1f1a">${esc(c.heading)}</h1>
<div style="font-size:15px;line-height:1.8">${c.paragraphs.map(paragraph).join("")}</div>
${facts}${button}${small}
</td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #edf1ef;font-size:12px;line-height:1.7;color:#7a8a84">${esc(c.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    c.heading,
    "",
    ...c.paragraphs.flatMap((p) => [p.trim(), ""]),
    ...(c.facts ?? []).map(([label, value]) => `${label}: ${value}`),
    ...(c.facts?.length ? [""] : []),
    ...(c.button ? [`${c.button.label}: ${c.button.url}`, ""] : []),
    ...(c.notes ?? []),
    "",
    "—",
    c.footer,
  ].join("\n");

  return { html, text };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const TEXT = {
  ar: {
    brand: "ميزان",
    hello: (name: string) => `أهلاً ${name}،`,
    linkFallback: "لو الزرار مش شغال، انسخ اللينك ده وافتحه في المتصفح:",
    footerAccount: "الإيميل ده اتبعت من ميزان، برنامج الفواتير والحسابات.",
    footerCompany: (company: string) =>
      `الإيميل ده اتبعت من ${company} عن طريق ميزان. لو عندك أي سؤال، رد على الإيميل ده.`,
    roles: { owner: "مالك الشركة", accountant: "محاسب", sales: "مبيعات", viewer: "مشاهد" } as Record<string, string>,
    reset: {
      subject: "استعادة كلمة السر على ميزان",
      heading: "اختار كلمة سر جديدة",
      body: "وصلنا طلب لتغيير كلمة السر بتاعة حسابك على ميزان. دوس على الزرار واختار كلمة سر جديدة.",
      button: "اختار كلمة سر جديدة",
      expires: (minutes: number) => `اللينك شغال لمدة ${minutes} دقيقة، ولمرة واحدة بس.`,
      ignore: "لو مش انت اللي طلبت ده، تجاهل الإيميل ده وكلمة السر هتفضل زي ما هي.",
    },
    verify: {
      subject: "أكد إيميلك على ميزان",
      heading: "أكد إيميلك",
      body: (email: string) => `دوس على الزرار علشان تأكد إن ${email} هو إيميلك على ميزان.`,
      button: "تأكيد الإيميل",
      expires: (hours: number) => `اللينك شغال لمدة ${hours} ساعة.`,
      ignore: "لو مش انت اللي عملت الحساب ده، تجاهل الإيميل.",
    },
    invite: {
      subject: (company: string) => `دعوة للانضمام لـ ${company} على ميزان`,
      heading: (company: string) => `انضم لفريق ${company}`,
      body: (inviter: string, company: string, role: string) =>
        `${inviter} دعاك تنضم لـ ${company} على ميزان بدور «${role}». دوس على الزرار واختار كلمة السر بتاعتك.`,
      button: "قبول الدعوة",
      expires: (days: number) => `الدعوة شغالة لمدة ${days} أيام.`,
    },
    invoice: {
      subject: (number: string, company: string) => `فاتورة ${number} من ${company}`,
      heading: (number: string) => `فاتورة ${number}`,
      body: (company: string, total: string, due: string) =>
        `دي فاتورتك من ${company} بقيمة ${total}، وميعاد استحقاقها ${due}.`,
      bodyPaid: (company: string, total: string) => `دي فاتورتك من ${company} بقيمة ${total}، واتدفعت بالكامل. شكراً ليك.`,
      number: "رقم الفاتورة",
      issued: "تاريخ الإصدار",
      due: "تاريخ الاستحقاق",
      total: "الإجمالي",
      remaining: "المتبقي",
      button: "عرض الفاتورة",
    },
    reminder: {
      subject: (number: string, company: string) => `تذكير بالفاتورة ${number} من ${company}`,
      subjectOverdue: (number: string, company: string) => `الفاتورة ${number} من ${company} متأخرة`,
      heading: (number: string) => `تذكير بالفاتورة ${number}`,
    },
    quote: {
      subject: (number: string, company: string) => `عرض سعر ${number} من ${company}`,
      heading: (number: string) => `عرض سعر ${number}`,
      body: (company: string, total: string, until: string) =>
        `بعتنالك عرض سعر من ${company} بقيمة ${total}، ساري لحد ${until}. تقدر تشوف التفاصيل وتوافق عليه أو ترفضه من الزرار تحت.`,
      number: "رقم العرض",
      total: "الإجمالي",
      validUntil: "ساري حتى",
      button: "عرض السعر والرد عليه",
    },
    payslip: {
      subject: (month: string, company: string) => `قسيمة مرتب ${month} من ${company}`,
      heading: (month: string) => `قسيمة مرتب ${month}`,
      body: (company: string, month: string, net: string) => `دي قسيمة مرتبك عن ${month} من ${company}، وصافي المرتب ${net}.`,
      base: "الراتب الأساسي",
      allowances: "البدلات",
      bonus: "حوافز ومكافآت",
      overtime: "إضافي",
      gross: "إجمالي المستحق",
      absence: (days: string) => `غياب وإجازة بدون مرتب (${days} يوم)`,
      other: "خصومات أخرى",
      insurance: "التأمينات الاجتماعية",
      tax: "ضريبة كسب العمل",
      advance: "قسط السلفة",
      net: "صافي المرتب",
      paidOn: "تاريخ الصرف",
    },
    notices: {
      footer: (setting: string) =>
        `بيوصلك الإيميل ده من ميزان علشان «${setting}» شغّال في الإعدادات ← الإشعارات، وتقدر تقفله من هناك.`,
      invoices: (n: number) => (n === 1 ? "فاتورة واحدة" : n === 2 ? "فاتورتين" : n <= 10 ? `${n} فواتير` : `${n} فاتورة`),
      tasks: (n: number) => (n === 1 ? "مهمة واحدة" : n === 2 ? "مهمتين" : n <= 10 ? `${n} مهام` : `${n} مهمة`),
      overdue: {
        setting: "فاتورة متأخرة",
        subject: (invoices: string, company: string) => `${invoices} متأخرة في ${company}`,
        heading: "فواتير عدّى ميعاد استحقاقها",
        // No full stop after the amount: "ج.م." already ends with one.
        body: (invoices: string, total: string) => `عندك ${invoices} عدّى ميعاد استحقاقها، والمتبقي عليها ${total}`,
        late: (remaining: string, days: number) => `${remaining} · متأخرة ${days} يوم`,
        more: (invoices: string) => `ومعاهم ${invoices} كمان في صفحة الفواتير.`,
        button: "عرض الفواتير",
      },
      payment: {
        setting: "دفعة جديدة",
        subject: (amount: string, customer: string) => `دفعة جديدة ${amount} من ${customer}`,
        heading: "اتسجلت دفعة جديدة",
        byUser: (name: string) => `${name} سجّل دفعة على فاتورة.`,
        byCustomer: "عميل دفع فاتورة أونلاين.",
        invoice: "الفاتورة",
        customer: "العميل",
        amount: "المبلغ",
        method: "طريقة الدفع",
        date: "التاريخ",
        methods: {
          cash: "كاش",
          bank: "تحويل بنكي",
          card: "كارت",
          instapay: "إنستاباي",
          vodafoneCash: "فودافون كاش",
          cheque: "شيك",
        } as Record<string, string>,
        button: "عرض الفاتورة",
      },
      taskList: {
        setting: "تذكير المهام",
        subject: (tasks: string) => `عندك ${tasks} النهارده`,
        heading: "مهام النهارده",
        body: (name: string) => `صباح الخير ${name}، دي المهام اللي ميعادها النهارده:`,
        priorities: { urgent: "عاجلة", important: "مهمة", normal: "عادية" } as Record<string, string>,
        button: "فتح المهام",
      },
      digest: {
        setting: "ملخص أسبوعي",
        subject: (company: string) => `ملخص الأسبوع في ${company}`,
        heading: "ملخص الأسبوع",
        body: (from: string, to: string) => `ده ملخص شغلك من ${from} لحد ${to}، ووضع الفلوس النهارده.`,
        invoiced: (invoices: string) => `فواتير صدرت (${invoices})`,
        collected: "اتحصّل",
        expenses: "مصروفات",
        outstanding: "مستحق عند العملاء دلوقتي",
        overdue: (invoices: string) => `منه متأخر (${invoices})`,
        dueSoon: "مستحق خلال الأسبوع الجاي",
        button: "فتح لوحة التحكم",
      },
    },
  },
  en: {
    brand: "Mizan",
    hello: (name: string) => `Hello ${name},`,
    linkFallback: "If the button doesn't work, copy this link into your browser:",
    footerAccount: "This email was sent by Mizan, the invoicing and accounting app.",
    footerCompany: (company: string) =>
      `This email was sent by ${company} through Mizan. Have a question? Just reply to this email.`,
    roles: { owner: "Owner", accountant: "Accountant", sales: "Sales", viewer: "Viewer" } as Record<string, string>,
    reset: {
      subject: "Reset your Mizan password",
      heading: "Choose a new password",
      body: "We got a request to change the password of your Mizan account. Use the button to choose a new one.",
      button: "Choose a new password",
      expires: (minutes: number) => `The link works for ${minutes} minutes, and only once.`,
      ignore: "If you didn't ask for this, ignore this email; your password stays as it is.",
    },
    verify: {
      subject: "Confirm your email on Mizan",
      heading: "Confirm your email",
      body: (email: string) => `Use the button to confirm that ${email} is your email on Mizan.`,
      button: "Confirm email",
      expires: (hours: number) => `The link works for ${hours} hours.`,
      ignore: "If you didn't create this account, ignore this email.",
    },
    invite: {
      subject: (company: string) => `Join ${company} on Mizan`,
      heading: (company: string) => `Join the ${company} team`,
      body: (inviter: string, company: string, role: string) =>
        `${inviter} invited you to join ${company} on Mizan as ${role}. Use the button to choose your password.`,
      button: "Accept the invitation",
      expires: (days: number) => `The invitation works for ${days} days.`,
    },
    invoice: {
      subject: (number: string, company: string) => `Invoice ${number} from ${company}`,
      heading: (number: string) => `Invoice ${number}`,
      body: (company: string, total: string, due: string) => `Here is your invoice from ${company} for ${total}, due on ${due}.`,
      bodyPaid: (company: string, total: string) => `Here is your invoice from ${company} for ${total}. It is paid in full; thank you.`,
      number: "Invoice number",
      issued: "Issue date",
      due: "Due date",
      total: "Total",
      remaining: "Still due",
      button: "View the invoice",
    },
    reminder: {
      subject: (number: string, company: string) => `Reminder: invoice ${number} from ${company}`,
      subjectOverdue: (number: string, company: string) => `Invoice ${number} from ${company} is overdue`,
      heading: (number: string) => `A reminder about invoice ${number}`,
    },
    quote: {
      subject: (number: string, company: string) => `Quote ${number} from ${company}`,
      heading: (number: string) => `Quote ${number}`,
      body: (company: string, total: string, until: string) =>
        `${company} sent you a quote for ${total}, valid until ${until}. Use the button to see it and accept or decline it.`,
      number: "Quote number",
      total: "Total",
      validUntil: "Valid until",
      button: "View and respond",
    },
    payslip: {
      subject: (month: string, company: string) => `${month} payslip from ${company}`,
      heading: (month: string) => `Payslip, ${month}`,
      body: (company: string, month: string, net: string) => `Here is your payslip for ${month} from ${company}. Your net pay is ${net}.`,
      base: "Base salary",
      allowances: "Allowances",
      bonus: "Bonuses",
      overtime: "Overtime",
      gross: "Gross pay",
      absence: (days: string) => `Absence and unpaid leave (${days} days)`,
      other: "Other deductions",
      insurance: "Social insurance",
      tax: "Income tax",
      advance: "Advance installment",
      net: "Net pay",
      paidOn: "Paid on",
    },
    notices: {
      footer: (setting: string) =>
        `Mizan sends you this email because "${setting}" is on in Settings → Notifications; you can turn it off there.`,
      invoices: (n: number) => (n === 1 ? "1 invoice" : `${n} invoices`),
      tasks: (n: number) => (n === 1 ? "1 task" : `${n} tasks`),
      overdue: {
        setting: "Overdue invoice",
        subject: (invoices: string, company: string) => `${invoices} overdue at ${company}`,
        heading: "Invoices past their due date",
        body: (invoices: string, total: string) => `You have ${invoices} past the due date, with ${total} still owed.`,
        late: (remaining: string, days: number) => `${remaining} · ${days} days late`,
        more: (invoices: string) => `And ${invoices} more on the invoices page.`,
        button: "View invoices",
      },
      payment: {
        setting: "New payment",
        subject: (amount: string, customer: string) => `New payment of ${amount} from ${customer}`,
        heading: "A new payment was recorded",
        byUser: (name: string) => `${name} recorded a payment on an invoice.`,
        byCustomer: "A customer paid an invoice online.",
        invoice: "Invoice",
        customer: "Customer",
        amount: "Amount",
        method: "Method",
        date: "Date",
        methods: {
          cash: "Cash",
          bank: "Bank transfer",
          card: "Card",
          instapay: "InstaPay",
          vodafoneCash: "Vodafone Cash",
          cheque: "Cheque",
        } as Record<string, string>,
        button: "View the invoice",
      },
      taskList: {
        setting: "Task reminder",
        subject: (tasks: string) => `You have ${tasks} due today`,
        heading: "Today's tasks",
        body: (name: string) => `Good morning ${name}, these tasks are due today:`,
        priorities: { urgent: "Urgent", important: "Important", normal: "Normal" } as Record<string, string>,
        button: "Open tasks",
      },
      digest: {
        setting: "Weekly digest",
        subject: (company: string) => `Your week at ${company}`,
        heading: "Your week",
        body: (from: string, to: string) => `Here is your week from ${from} to ${to}, and where the money stands today.`,
        invoiced: (invoices: string) => `Invoiced (${invoices})`,
        collected: "Collected",
        expenses: "Expenses",
        outstanding: "Owed by customers now",
        overdue: (invoices: string) => `Of which overdue (${invoices})`,
        dueSoon: "Due in the coming week",
        button: "Open the dashboard",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Account emails (from Mizan)
// ---------------------------------------------------------------------------

export function passwordResetEmail(locale: Locale, to: { email: string; name: string }, url: string, minutes: number): Mail {
  const t = TEXT[locale];
  return {
    to: to.email,
    subject: t.reset.subject,
    tag: "password-reset",
    ...render({
      locale,
      preview: t.reset.body,
      senderName: t.brand,
      heading: t.reset.heading,
      paragraphs: [t.hello(to.name), t.reset.body],
      button: { label: t.reset.button, url },
      notes: [t.reset.expires(minutes), t.reset.ignore],
      footer: t.footerAccount,
    }),
  };
}

export function verifyEmailEmail(locale: Locale, to: { email: string; name: string }, url: string, hours: number): Mail {
  const t = TEXT[locale];
  return {
    to: to.email,
    subject: t.verify.subject,
    tag: "verify-email",
    ...render({
      locale,
      preview: t.verify.body(to.email),
      senderName: t.brand,
      heading: t.verify.heading,
      paragraphs: [t.hello(to.name), t.verify.body(to.email)],
      button: { label: t.verify.button, url },
      notes: [t.verify.expires(hours), t.verify.ignore],
      footer: t.footerAccount,
    }),
  };
}

export function invitationEmail(
  locale: Locale,
  invite: { email: string; name: string; role: string; inviter: string; company: string; url: string; days: number },
): Mail {
  const t = TEXT[locale];
  const role = t.roles[invite.role] ?? invite.role;
  return {
    to: invite.email,
    subject: t.invite.subject(invite.company),
    tag: "invitation",
    ...render({
      locale,
      preview: t.invite.body(invite.inviter, invite.company, role),
      senderName: t.brand,
      heading: t.invite.heading(invite.company),
      paragraphs: [t.hello(invite.name), t.invite.body(invite.inviter, invite.company, role)],
      button: { label: t.invite.button, url: invite.url },
      notes: [t.invite.expires(invite.days)],
      footer: t.footerAccount,
    }),
  };
}

// ---------------------------------------------------------------------------
// Emails to a company's customers (from the company, through Mizan)
// ---------------------------------------------------------------------------

export type Sender = {
  company: string;
  /** The user sending it: replies go to them. */
  replyTo: string;
};

type InvoiceFacts = {
  number: string;
  customer: string;
  issueDate: string;
  dueDate: string;
  total: string;
  remaining: string;
  currency: string;
  paid: boolean;
  overdue: boolean;
  url: string;
};

function invoiceFacts(locale: Locale, inv: InvoiceFacts): [string, string][] {
  const t = TEXT[locale].invoice;
  const money = (v: string) => formatMoney(locale, v, inv.currency);
  return [
    [t.number, inv.number],
    [t.issued, formatDate(locale, inv.issueDate)],
    [t.due, formatDate(locale, inv.dueDate)],
    [t.total, money(inv.total)],
    ...(inv.paid || inv.remaining === inv.total ? [] : ([[t.remaining, money(inv.remaining)]] as [string, string][])),
  ];
}

export function invoiceEmail(locale: Locale, to: string, from: Sender, inv: InvoiceFacts, message?: string): Mail {
  const t = TEXT[locale];
  const total = formatMoney(locale, inv.total, inv.currency);
  const body = inv.paid ? t.invoice.bodyPaid(from.company, total) : t.invoice.body(from.company, total, formatDate(locale, inv.dueDate));
  return {
    to,
    subject: t.invoice.subject(inv.number, from.company),
    replyTo: from.replyTo,
    tag: "invoice",
    ...render({
      locale,
      preview: body,
      senderName: t.brand,
      heading: t.invoice.heading(inv.number),
      paragraphs: message?.trim() ? [message] : [t.hello(inv.customer), body],
      facts: invoiceFacts(locale, inv),
      button: { label: t.invoice.button, url: inv.url },
      footer: t.footerCompany(from.company),
    }),
  };
}

/** A payment reminder: the user's own words (or a plain one), then the invoice and its link. */
export function reminderEmail(locale: Locale, to: string, from: Sender, inv: InvoiceFacts, message?: string): Mail {
  const t = TEXT[locale];
  const body = t.invoice.body(from.company, formatMoney(locale, inv.remaining, inv.currency), formatDate(locale, inv.dueDate));
  const paragraphs = message?.trim() ? [message] : [t.hello(inv.customer), body];
  return {
    to,
    subject: (inv.overdue ? t.reminder.subjectOverdue : t.reminder.subject)(inv.number, from.company),
    replyTo: from.replyTo,
    tag: "reminder",
    ...render({
      locale,
      preview: paragraphs.join(" ").slice(0, 140),
      senderName: t.brand,
      heading: t.reminder.heading(inv.number),
      paragraphs,
      facts: invoiceFacts(locale, inv),
      button: { label: t.invoice.button, url: inv.url },
      footer: t.footerCompany(from.company),
    }),
  };
}

export function quoteEmail(
  locale: Locale,
  to: string,
  from: Sender,
  quote: { number: string; customer: string; total: string; currency: string; validUntil: string; url: string },
  message?: string,
): Mail {
  const t = TEXT[locale];
  const total = formatMoney(locale, quote.total, quote.currency);
  const until = formatDate(locale, quote.validUntil);
  const body = t.quote.body(from.company, total, until);
  return {
    to,
    subject: t.quote.subject(quote.number, from.company),
    replyTo: from.replyTo,
    tag: "quote",
    ...render({
      locale,
      preview: body,
      senderName: t.brand,
      heading: t.quote.heading(quote.number),
      paragraphs: message?.trim() ? [message] : [t.hello(quote.customer), body],
      facts: [
        [t.quote.number, quote.number],
        [t.quote.total, total],
        [t.quote.validUntil, until],
      ],
      button: { label: t.quote.button, url: quote.url },
      footer: t.footerCompany(from.company),
    }),
  };
}

// ---------------------------------------------------------------------------
// Payslips (to a company's employees, through Mizan)
// ---------------------------------------------------------------------------

type PayslipFacts = {
  month: string;
  paidOn: string | null;
  company: { name: string; currency: string };
  item: {
    name: string;
    baseSalary: string;
    allowances: string;
    bonus: string;
    overtime: string;
    gross: string;
    absenceDays: string;
    absenceDeduction: string;
    otherDeductions: string;
    insurance: string;
    incomeTax: string;
    advanceDeduction: string;
    net: string;
  };
};

/** "نوفمبر 2026" / "November 2026". */
export function formatMonth(locale: Locale, month: string) {
  const tag = locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
  return new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

/** The pay, line by line: what is earned, what comes off (only what applies), and the net. */
export function payslipEmail(locale: Locale, to: string, from: Sender, slip: PayslipFacts, message?: string): Mail {
  const t = TEXT[locale];
  const p = t.payslip;
  const i = slip.item;
  const money = (v: string) => formatMoney(locale, v, slip.company.currency);
  const off = (v: string) => `− ${money(v)}`;
  const some = (v: string) => Number(v) > 0;
  const month = formatMonth(locale, slip.month);
  const body = p.body(from.company, month, money(i.net));
  const facts: [string, string][] = [
    [p.base, money(i.baseSalary)],
    ...(some(i.allowances) ? [[p.allowances, money(i.allowances)] as [string, string]] : []),
    ...(some(i.bonus) ? [[p.bonus, money(i.bonus)] as [string, string]] : []),
    ...(some(i.overtime) ? [[p.overtime, money(i.overtime)] as [string, string]] : []),
    [p.gross, money(i.gross)],
    ...(some(i.absenceDeduction) ? [[p.absence(i.absenceDays), off(i.absenceDeduction)] as [string, string]] : []),
    ...(some(i.otherDeductions) ? [[p.other, off(i.otherDeductions)] as [string, string]] : []),
    ...(some(i.insurance) ? [[p.insurance, off(i.insurance)] as [string, string]] : []),
    ...(some(i.incomeTax) ? [[p.tax, off(i.incomeTax)] as [string, string]] : []),
    ...(some(i.advanceDeduction) ? [[p.advance, off(i.advanceDeduction)] as [string, string]] : []),
    [p.net, money(i.net)],
    ...(slip.paidOn ? [[p.paidOn, formatDate(locale, slip.paidOn)] as [string, string]] : []),
  ];
  return {
    to,
    subject: p.subject(month, from.company),
    replyTo: from.replyTo,
    tag: "payslip",
    ...render({
      locale,
      preview: body,
      senderName: t.brand,
      heading: p.heading(month),
      paragraphs: message?.trim() ? [t.hello(i.name), message] : [t.hello(i.name), body],
      facts,
      footer: t.footerCompany(from.company),
    }),
  };
}

// ---------------------------------------------------------------------------
// Notices to the team (from Mizan, each one a switch in Settings → Notifications)
// ---------------------------------------------------------------------------

type Person = { email: string; name: string };

/** The daily list of overdue invoices (the oldest first; the rest counted). */
export function overdueAlertEmail(
  locale: Locale,
  to: Person,
  company: string,
  o: {
    count: number;
    total: string;
    currency: string;
    items: { number: string; customer: string; remaining: string; daysLate: number }[];
    url: string;
  },
): Mail {
  const t = TEXT[locale];
  const n = t.notices.overdue;
  const body = n.body(t.notices.invoices(o.count), formatMoney(locale, o.total, o.currency));
  const extra = o.count - o.items.length;
  return {
    to: to.email,
    subject: n.subject(t.notices.invoices(o.count), company),
    tag: "notice-overdue",
    ...render({
      locale,
      preview: body,
      senderName: t.brand,
      heading: n.heading,
      paragraphs: [t.hello(to.name), body],
      facts: o.items.map((i) => [`${i.number} · ${i.customer}`, n.late(formatMoney(locale, i.remaining, o.currency), i.daysLate)]),
      button: { label: n.button, url: o.url },
      ...(extra > 0 ? { notes: [n.more(t.notices.invoices(extra))] } : {}),
      footer: t.notices.footer(n.setting),
    }),
  };
}

/** A payment recorded by someone else on the team, or paid online by a customer. */
export function paymentNoticeEmail(
  locale: Locale,
  to: Person,
  p: { invoice: string; customer: string; amount: string; currency: string; method: string; date: string; by: string | null; url: string },
): Mail {
  const t = TEXT[locale];
  const n = t.notices.payment;
  const amount = formatMoney(locale, p.amount, p.currency);
  const body = p.by ? n.byUser(p.by) : n.byCustomer;
  return {
    to: to.email,
    subject: n.subject(amount, p.customer),
    tag: "notice-payment",
    ...render({
      locale,
      preview: body,
      senderName: t.brand,
      heading: n.heading,
      paragraphs: [t.hello(to.name), body],
      facts: [
        [n.invoice, p.invoice],
        [n.customer, p.customer],
        [n.amount, amount],
        [n.method, n.methods[p.method] ?? p.method],
        [n.date, formatDate(locale, p.date)],
      ],
      button: { label: n.button, url: p.url },
      footer: t.notices.footer(n.setting),
    }),
  };
}

/** The morning list of someone's tasks due today. */
export function tasksDueEmail(
  locale: Locale,
  to: Person,
  tasks: { title: string; priority: string; customer: string | null }[],
  url: string,
): Mail {
  const t = TEXT[locale];
  const n = t.notices.taskList;
  const count = t.notices.tasks(tasks.length);
  return {
    to: to.email,
    subject: n.subject(count),
    tag: "notice-tasks",
    ...render({
      locale,
      preview: tasks.map((task) => task.title).join(" · ").slice(0, 140),
      senderName: t.brand,
      heading: n.heading,
      paragraphs: [n.body(to.name)],
      facts: tasks.map((task) => [task.customer ? `${task.title} · ${task.customer}` : task.title, n.priorities[task.priority] ?? task.priority]),
      button: { label: n.button, url },
      footer: t.notices.footer(n.setting),
    }),
  };
}

/** Saturday's digest: the past week, and what customers owe today. */
export function weeklyDigestEmail(
  locale: Locale,
  to: Person,
  company: string,
  d: {
    from: string;
    to: string;
    currency: string;
    invoiced: string;
    invoicedCount: number;
    collected: string;
    expenses: string;
    outstanding: string;
    overdue: string;
    overdueCount: number;
    dueSoon: string;
    url: string;
  },
): Mail {
  const t = TEXT[locale];
  const n = t.notices.digest;
  const money = (v: string) => formatMoney(locale, v, d.currency);
  const body = n.body(formatDate(locale, d.from), formatDate(locale, d.to));
  return {
    to: to.email,
    subject: n.subject(company),
    tag: "notice-digest",
    ...render({
      locale,
      preview: body,
      senderName: t.brand,
      heading: n.heading,
      paragraphs: [t.hello(to.name), body],
      facts: [
        [n.invoiced(t.notices.invoices(d.invoicedCount)), money(d.invoiced)],
        [n.collected, money(d.collected)],
        [n.expenses, money(d.expenses)],
        [n.outstanding, money(d.outstanding)],
        [n.overdue(t.notices.invoices(d.overdueCount)), money(d.overdue)],
        [n.dueSoon, money(d.dueSoon)],
      ],
      button: { label: n.button, url: d.url },
      footer: t.notices.footer(n.setting),
    }),
  };
}
