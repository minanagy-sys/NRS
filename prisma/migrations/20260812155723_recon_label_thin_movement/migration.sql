-- DropIndex
DROP INDEX "ReconProduct_source_soldName_stockName_key";

-- AlterTable
ALTER TABLE "ExpiryLot" DROP COLUMN "netIssued",
ADD COLUMN     "thinMovement" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReconProduct" ADD COLUMN     "label" TEXT NOT NULL,
ALTER COLUMN "soldName" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ReconProduct_source_label_key" ON "ReconProduct"("source", "label");

