-- CreateTable
CREATE TABLE "CommissionPolicyVersion" (
    "version" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "achievementFloor" DECIMAL(6,4) NOT NULL,
    "midFrom" DECIMAL(6,4) NOT NULL,
    "maxFrom" DECIMAL(6,4) NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPolicyVersion_pkey" PRIMARY KEY ("version")
);

-- CreateIndex
CREATE INDEX "CommissionPolicyVersion_effectiveFrom_idx" ON "CommissionPolicyVersion"("effectiveFrom");
