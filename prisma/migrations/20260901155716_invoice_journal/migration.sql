-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "journalId" INTEGER,
ADD COLUMN     "journalName" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_journalName_idx" ON "Invoice"("journalName");
