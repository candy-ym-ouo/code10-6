import type { FastifyPluginAsync } from "fastify";
import {
  annotationBatchDeleteSchema,
  annotationBatchUpdateSchema,
  annotationCreateSchema,
  annotationListQuerySchema,
  annotationUpdateSchema,
  validateAnnotationRange,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";

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
      include: { media: { select: { durationMs: true } } },
    });
    if (!existing) throw notFound();
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

  // 批量校正：对同一练习内的多个标记统一调整类型 / 严重度，整笔事务提交。
  app.patch("/sessions/:sessionId/annotations/batch", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = parseOrThrow(annotationBatchUpdateSchema, request.body);
    const session = await prisma.practiceSession.findFirst({
      where: { id: sessionId, userId: request.authUser!.id },
      select: { id: true },
    });
    if (!session) throw notFound();

    const ids = [...new Set(input.ids)];
    const owned = await prisma.annotation.findMany({
      where: { id: { in: ids }, sessionId, userId: request.authUser!.id },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new AppError(400, "VALIDATION_ERROR", "部分标记不存在或不属于当前练习");
    }

    const data = {
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
    };
    const annotations = await prisma.$transaction(async (tx) => {
      await tx.annotation.updateMany({ where: { id: { in: ids }, sessionId, userId: request.authUser!.id }, data });
      return tx.annotation.findMany({
        where: { id: { in: ids } },
        orderBy: [{ startMs: "asc" }, { createdAt: "asc" }],
        include: { goals: { select: { id: true, title: true, status: true } } },
      });
    });
    return { annotations };
  });

  // 批量删除：只解除目标关联，目标本体保留，避免悬空 annotation_id。
  app.post("/sessions/:sessionId/annotations/batch-delete", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = parseOrThrow(annotationBatchDeleteSchema, request.body);
    const session = await prisma.practiceSession.findFirst({
      where: { id: sessionId, userId: request.authUser!.id },
      select: { id: true },
    });
    if (!session) throw notFound();

    const ids = [...new Set(input.ids)];
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.annotation.findMany({
        where: { id: { in: ids }, sessionId, userId: request.authUser!.id },
        select: { id: true },
      });
      const foundIds = rows.map((row) => row.id);
      const unlinked = await tx.goal.updateMany({
        where: { annotationId: { in: foundIds }, userId: request.authUser!.id },
        data: { annotationId: null },
      });
      const deleted = await tx.annotation.deleteMany({
        where: { id: { in: foundIds }, userId: request.authUser!.id },
      });
      return { foundIds, deletedCount: deleted.count, unlinkedCount: unlinked.count };
    });

    await audit(request, "ANNOTATION_BATCH_DELETED", "ANNOTATION", null, "SUCCESS", {
      sessionId,
      count: result.deletedCount,
      unlinkedGoals: result.unlinkedCount,
    }).catch(() => undefined);

    return {
      success: true,
      deletedIds: result.foundIds,
      deletedCount: result.deletedCount,
      unlinkedGoalCount: result.unlinkedCount,
    };
  });

  app.delete("/annotations/:id", async (request) => {
    const { id } = request.params as { id: string };
    // 并发删除时另一个请求可能已经完成删除：
    // 同一事务里先解除目标关联再删除标记，保证不留下悬空引用，且结果幂等。
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.annotation.findFirst({
        where: { id, userId: request.authUser!.id },
        select: { id: true, sessionId: true },
      });
      if (!existing) return null;
      const unlinked = await tx.goal.updateMany({
        where: { annotationId: id, userId: request.authUser!.id },
        data: { annotationId: null },
      });
      await tx.annotation.deleteMany({ where: { id, userId: request.authUser!.id } });
      return { sessionId: existing.sessionId, unlinkedCount: unlinked.count };
    });
    if (!result) return { success: true, deletedCount: 0, unlinkedGoalCount: 0 };

    await audit(request, "ANNOTATION_DELETED", "ANNOTATION", id, "SUCCESS", {
      sessionId: result.sessionId,
      unlinkedGoals: result.unlinkedCount,
    }).catch(() => undefined);

    return { success: true, deletedCount: 1, unlinkedGoalCount: result.unlinkedCount };
  });
};

export default annotationRoutes;
