-- CreateTable
CREATE TABLE "TargetDraft" (
    "id" SERIAL NOT NULL,
    "period" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL,
    "actor" TEXT,
    "note" TEXT,

    CONSTRAINT "TargetDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TargetDraft_period_key" ON "TargetDraft"("period");
