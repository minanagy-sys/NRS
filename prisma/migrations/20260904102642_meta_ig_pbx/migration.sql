-- CreateTable
CREATE TABLE "MetaDay" (
    "id" SERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "msgConversations" INTEGER NOT NULL DEFAULT 0,
    "onFbLeads" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'live',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaCampaign" (
    "id" SERIAL NOT NULL,
    "campaignId" TEXT,
    "accountId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "startDate" DATE,
    "budgetDaily" DECIMAL(14,2),
    "cost" DECIMAL(14,2) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "msgConversations" INTEGER NOT NULL DEFAULT 0,
    "onFbLeads" INTEGER NOT NULL DEFAULT 0,
    "doctor" TEXT,
    "service" TEXT,
    "branch" TEXT,
    "source" TEXT NOT NULL DEFAULT 'live',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAd" (
    "id" SERIAL NOT NULL,
    "adId" TEXT,
    "accountId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "msgConversations" INTEGER NOT NULL DEFAULT 0,
    "onFbLeads" INTEGER NOT NULL DEFAULT 0,
    "doctor" TEXT,
    "service" TEXT,
    "branch" TEXT,
    "inherited" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'live',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaLead" (
    "leadId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "formName" TEXT,
    "doctor" TEXT,
    "mobileKey" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'ad',
    "source" TEXT NOT NULL DEFAULT 'live',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaLead_pkey" PRIMARY KEY ("leadId")
);

-- CreateTable
CREATE TABLE "IgProfileDay" (
    "id" SERIAL NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "followers" INTEGER NOT NULL DEFAULT 0,
    "newFollowers" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'live',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IgProfileDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IgPost" (
    "id" SERIAL NOT NULL,
    "postId" TEXT,
    "profileId" TEXT NOT NULL,
    "profileName" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "format" TEXT,
    "caption" TEXT,
    "permalink" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'live',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IgPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxDay" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "inboundCalls" INTEGER NOT NULL DEFAULT 0,
    "inboundAnswered" INTEGER NOT NULL DEFAULT 0,
    "dials" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxHour" (
    "id" SERIAL NOT NULL,
    "date" DATE,
    "hour" INTEGER NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "answered" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxHour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxQueueDay" (
    "id" SERIAL NOT NULL,
    "queue" TEXT NOT NULL,
    "date" DATE,
    "offered" INTEGER NOT NULL DEFAULT 0,
    "answered" INTEGER NOT NULL DEFAULT 0,
    "abandoned" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxQueueDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxAgentDay" (
    "id" SERIAL NOT NULL,
    "ext" TEXT NOT NULL,
    "agentName" TEXT,
    "date" DATE,
    "offered" INTEGER NOT NULL DEFAULT 0,
    "answered" INTEGER NOT NULL DEFAULT 0,
    "talkInSec" INTEGER NOT NULL DEFAULT 0,
    "dials" INTEGER NOT NULL DEFAULT 0,
    "connected" INTEGER NOT NULL DEFAULT 0,
    "talkOutSec" INTEGER NOT NULL DEFAULT 0,
    "daysActive" INTEGER NOT NULL DEFAULT 0,
    "spanMinutes" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxAgentDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatDay" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "channel" TEXT NOT NULL,
    "contacts" INTEGER NOT NULL DEFAULT 0,
    "handledByBot" INTEGER NOT NULL DEFAULT 0,
    "handledByHuman" INTEGER NOT NULL DEFAULT 0,
    "firstResponseSec" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataUpload" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT,
    "rangeFrom" DATE,
    "rangeTo" DATE,
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaDay_date_idx" ON "MetaDay"("date");

-- CreateIndex
CREATE INDEX "MetaDay_accountId_date_idx" ON "MetaDay"("accountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MetaDay_accountId_date_source_key" ON "MetaDay"("accountId", "date", "source");

-- CreateIndex
CREATE INDEX "MetaCampaign_accountId_idx" ON "MetaCampaign"("accountId");

-- CreateIndex
CREATE INDEX "MetaCampaign_doctor_idx" ON "MetaCampaign"("doctor");

-- CreateIndex
CREATE INDEX "MetaCampaign_service_idx" ON "MetaCampaign"("service");

-- CreateIndex
CREATE INDEX "MetaCampaign_startDate_idx" ON "MetaCampaign"("startDate");

-- CreateIndex
CREATE INDEX "MetaAd_accountId_idx" ON "MetaAd"("accountId");

-- CreateIndex
CREATE INDEX "MetaAd_campaignName_idx" ON "MetaAd"("campaignName");

-- CreateIndex
CREATE INDEX "MetaAd_service_idx" ON "MetaAd"("service");

-- CreateIndex
CREATE INDEX "MetaLead_createdAt_idx" ON "MetaLead"("createdAt");

-- CreateIndex
CREATE INDEX "MetaLead_mobileKey_idx" ON "MetaLead"("mobileKey");

-- CreateIndex
CREATE INDEX "MetaLead_doctor_idx" ON "MetaLead"("doctor");

-- CreateIndex
CREATE INDEX "MetaLead_channel_idx" ON "MetaLead"("channel");

-- CreateIndex
CREATE INDEX "IgProfileDay_date_idx" ON "IgProfileDay"("date");

-- CreateIndex
CREATE UNIQUE INDEX "IgProfileDay_profileId_date_source_key" ON "IgProfileDay"("profileId", "date", "source");

-- CreateIndex
CREATE INDEX "IgPost_profileId_postedAt_idx" ON "IgPost"("profileId", "postedAt");

-- CreateIndex
CREATE INDEX "PbxDay_date_idx" ON "PbxDay"("date");

-- CreateIndex
CREATE UNIQUE INDEX "PbxDay_date_source_key" ON "PbxDay"("date", "source");

-- CreateIndex
CREATE INDEX "PbxHour_hour_idx" ON "PbxHour"("hour");

-- CreateIndex
CREATE INDEX "PbxQueueDay_queue_idx" ON "PbxQueueDay"("queue");

-- CreateIndex
CREATE INDEX "PbxQueueDay_date_idx" ON "PbxQueueDay"("date");

-- CreateIndex
CREATE INDEX "PbxAgentDay_ext_idx" ON "PbxAgentDay"("ext");

-- CreateIndex
CREATE INDEX "PbxAgentDay_date_idx" ON "PbxAgentDay"("date");

-- CreateIndex
CREATE INDEX "ChatDay_date_idx" ON "ChatDay"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ChatDay_date_channel_source_key" ON "ChatDay"("date", "channel", "source");

-- CreateIndex
CREATE INDEX "DataUpload_kind_createdAt_idx" ON "DataUpload"("kind", "createdAt");
