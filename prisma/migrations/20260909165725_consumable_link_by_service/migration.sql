-- DropIndex
DROP INDEX "ConsumableLink_serviceName_key";

-- DropIndex
DROP INDEX "ConsumableLink_serviceProductId_idx";

-- AlterTable
ALTER TABLE "ConsumableLink" ADD COLUMN     "matchRule" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "packLabel" TEXT,
ALTER COLUMN "serviceName" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ConsumableLink_serviceProductId_key" ON "ConsumableLink"("serviceProductId");

-- CreateIndex
CREATE INDEX "ConsumableLink_packLabel_idx" ON "ConsumableLink"("packLabel");

