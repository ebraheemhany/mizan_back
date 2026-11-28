-- The invoice history shows credit notes issued and taken back.
ALTER TYPE "InvoiceEventType" ADD VALUE 'creditNote';
ALTER TYPE "InvoiceEventType" ADD VALUE 'creditNoteDeleted';
