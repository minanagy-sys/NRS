-- CreateTable
CREATE TABLE "PbxCall" (
    "id" SERIAL NOT NULL,
    "weekStart" DATE NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "direction" INTEGER NOT NULL,
    "ext" TEXT NOT NULL DEFAULT '',
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "waitSec" INTEGER NOT NULL DEFAULT -1,
    "talkSec" INTEGER NOT NULL DEFAULT 0,
    "phoneHash" TEXT,
    "queue" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'grandstream',
    "source" TEXT NOT NULL DEFAULT 'upload',
    "uploadId" INTEGER,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PbxCall_weekStart_idx" ON "PbxCall"("weekStart");

-- CreateIndex
CREATE INDEX "PbxCall_date_idx" ON "PbxCall"("date");

-- CreateIndex
CREATE INDEX "PbxCall_phoneHash_idx" ON "PbxCall"("phoneHash");
