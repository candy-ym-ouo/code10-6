import type { FastifyPluginAsync } from "fastify";
import {
  annotationBatchUpdateSchema,
  annotationCreateSchema,
  annotationListQuerySchema,
  annotationUpdateSchema,
  validateAnnotationRange,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { parseOrThrow } from "../lib/validation.js";

const annotationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/sessions/:sessionId/annotations", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = parseOrThrow(annotationListQuerySchema, request.query);
    const session = await prisma.practiceSession.findFirst({ where: { id: sessionId, userId: request.authUser!.id }, select: { id: true } });
    if (!session) throw notFound();
    const annotations = await prisma.annotation.findMany({
      where: {
        sessionId,
        userId: request.authUser!.id,
        ...(query.mediaId ? { mediaId: query.mediaId } : {}),
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: [{ startMs: "asc" }, { createdAt: "asc" }],
      include: { goals: { select: { id: true, title: true, status: true } } },
    });
    return { annotations };
  });

  app.post("/sessions/:sessionId/annotations", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = parseOrThrow(annotationCreateSchema, request.body);
    const media = await prisma.mediaAsset.findFirst({
      where: { id: input.mediaId, sessionId, userId: request.authUser!.id },
      include: { session: { select: { status: true } } },
    });
    if (!media) throw notFound();
    if (media.status !== "READY") throw new AppError(409, "MEDIA_NOT_READY", "音频尚未完成解析");
    if (!["DRAFT", "IN_REVIEW", "COMPLETED"].includes(media.session.status)) {
      throw new AppError(409, "INVALID_SESSION_STATE", "当前练习状态不能添加标记");
    }
    const range = validateAnnotationRange(input.startMs, input.endMs, media.durationMs ? Number(media.durationMs) : null);
    if (!range.ok) throw new AppError(400, range.code, range.message);
    const annotation = await prisma.annotation.create({
      data: {
        userId: request.authUser!.id,
        sessionId,
        mediaId: input.mediaId,
        type: input.type,
        severity: input.severity,
        startMs: input.startMs,
        endMs: input.endMs,
        title: input.title,
        description: input.description ?? null,
        nextAction: input.nextAction ?? null,
      },
    });
    return reply.status(201).send({ annotation });
  });

  app.patch("/annotations/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(annotationUpdateSchema, request.body);
    const existing = await prisma.annotation.findFirst({
      where: { id, userId: request.authUser!.id },
      include: { media: { select: { durationMs: true, session: { select: { status: true } } } } },
    });
    if (!existing) throw notFound();
    if (!["DRAFT", "IN_REVIEW", "COMPLETED"].includes(existing.media.session.status)) {
      throw new AppError(409, "INVALID_SESSION_STATE", "当前练习状态不能编辑标记");
    }
    const startMs = input.startMs ?? Number(existing.startMs);
    const endMs = input.endMs ?? Number(existing.endMs);
    const range = validateAnnotationRange(startMs, endMs, existing.media.durationMs ? Number(existing.media.durationMs) : null);
    if (!range.ok) throw new AppError(400, range.code, range.message);
    const annotation = await prisma.annotation.update({
      where: { id },
      data: {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.startMs === undefined ? {} : { startMs: input.startMs }),
        ...(input.endMs === undefined ? {} : { endMs: input.endMs }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }),
      },
    });
    return { annotation };
  });

  app.patch("/sessions/:sessionId/annotations/batch", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = parseOrThrow(annotationBatchUpdateSchema, request.body);
    const session = await prisma.practiceSession.findFirst({
      where: { id: sessionId, userId: request.authUser!.id },
      select: { id: true, status: true },
    });
    if (!session) throw notFound();
    if (!["DRAFT", "IN_REVIEW", "COMPLETED"].includes(session.status)) {
      throw new AppError(409, "INVALID_SESSION_STATE", "当前练习状态不能校正标记");
    }
    const ids = Array.from(new Set(input.ids));
    const owned = await prisma.annotation.findMany({
      where: { id: { in: ids }, sessionId, userId: request.authUser!.id },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new AppError(404, "RESOURCE_NOT_FOUND", "部分标记不存在或不属于当前练习");
    }
    const data = {
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }),
    };
    const annotations = await prisma.$transaction(async (tx) => {
      // 与删除并发时，锁内若有标记消失则 count 不匹配，整体回滚，不会出现部分写入。
      const result = await tx.annotation.updateMany({
        where: { id: { in: ids }, sessionId, userId: request.authUser!.id },
        data,
      });
      if (result.count !== ids.length) {
        throw new AppError(409, "ANNOTATIONS_CHANGED", "标记已在其他窗口被删除，请刷新后重试");
      }
      return tx.annotation.findMany({
        where: { id: { in: ids }, sessionId },
        orderBy: [{ startMs: "asc" }, { createdAt: "asc" }],
        include: { goals: { select: { id: true, title: true, status: true } } },
      });
    });
    return { annotations };
  });

  app.delete("/annotations/:id", async (request) => {
    const { id } = request.params as { id: string };
    const userId = request.authUser!.id;
    const result = await prisma.$transaction(async (tx) => {
      // 先在应用层显式解除目标关联，再删除标记；并发删除时整段为空，返回 404，
      // 不依赖隐式 ON DELETE SET NULL，也绝不会留下悬空的 annotation_id。
      const existing = await tx.annotation.findFirst({
        where: { id, userId },
        select: { id: true, goals: { select: { id: true } } },
      });
      if (!existing) return null;
      const unlinkedGoalIds = existing.goals.map((goal) => goal.id);
      if (unlinkedGoalIds.length > 0) {
        await tx.goal.updateMany({
          where: { id: { in: unlinkedGoalIds }, annotationId: id },
          data: { annotationId: null },
        });
      }
      await tx.annotation.delete({ where: { id } });
      return { unlinkedGoalIds };
    });
    if (!result) throw notFound();
    return { success: true, unlinkedGoalIds: result.unlinkedGoalIds };
  });
};

export default annotationRoutes;
