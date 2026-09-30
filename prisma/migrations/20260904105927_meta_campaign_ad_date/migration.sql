-- AlterTable
ALTER TABLE "MetaAd" ADD COLUMN     "date" DATE;

-- AlterTable
ALTER TABLE "MetaCampaign" ADD COLUMN     "date" DATE;

-- CreateIndex
CREATE INDEX "MetaAd_date_idx" ON "MetaAd"("date");

-- CreateIndex
CREATE INDEX "MetaAd_accountId_date_idx" ON "MetaAd"("accountId", "date");

-- CreateIndex
CREATE INDEX "MetaCampaign_date_idx" ON "MetaCampaign"("date");

-- CreateIndex
CREATE INDEX "MetaCampaign_accountId_date_idx" ON "MetaCampaign"("accountId", "date");
