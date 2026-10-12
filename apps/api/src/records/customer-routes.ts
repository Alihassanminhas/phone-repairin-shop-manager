import { Router } from 'express';
import { z } from 'zod';

import { customerSchema } from '@repair-shop/shared';

import { requireOwner } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { asyncHandler } from '../http/async-handler.js';
import { notFound } from '../http/errors.js';
import { getAuthContext } from '../http/request-context.js';

const customerIdSchema = z.object({ customerId: z.string().uuid() });
const searchSchema = z.object({ q: z.string().trim().max(120).default(''), limit: z.coerce.number().int().min(1).max(200).default(100) });
const customerUpdateSchema = customerSchema.omit({ id: true }).partial().refine((value) => Object.keys(value).length > 0);

export const customerRouter = Router();
customerRouter.use(requireOwner);

customerRouter.get('/', asyncHandler(async (request, response) => {
  const query = searchSchema.parse(request.query);
  const { ownerId } = getAuthContext(request);
  const customers = await prisma.customer.findMany({
    where: {
      ownerId,
      archivedAt: null,
      ...(query.q ? { OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { phone: { contains: query.q } },
      ] } : {}),
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: query.limit,
    include: {
      repairs: {
        where: { archivedAt: null },
        select: {
          finalCostPaisa: true,
          payments: { select: { amountPaisa: true, reversals: { select: { amountPaisa: true } } } },
        },
      },
    },
  });
  response.json({ customers: customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    alternatePhone: customer.alternatePhone,
    address: customer.address,
    notes: customer.notes,
    repairCount: customer.repairs.length,
    outstandingPaisa: customer.repairs.reduce((sum, repair) => {
      if (repair.finalCostPaisa === null) return sum;
      const paid = repair.payments.reduce((repairSum, payment) => repairSum + payment.amountPaisa - payment.reversals.reduce((reversed, row) => reversed + row.amountPaisa, 0n), 0n);
      const balance = repair.finalCostPaisa - paid;
      return sum + (balance > 0n ? balance : 0n);
    }, 0n).toString(),
    version: customer.version,
    updatedAt: customer.updatedAt,
  })) });
}));

customerRouter.post('/', asyncHandler(async (request, response) => {
  const input = customerSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const existing = await prisma.customer.findFirst({
    where: { ownerId, archivedAt: null, phone: input.phone },
    select: { id: true, name: true, phone: true, version: true },
  });
  if (existing) {
    response.status(200).json({ customer: existing, reused: true });
    return;
  }
  const customer = await prisma.customer.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      ownerId,
      name: input.name,
      phone: input.phone,
      ...(input.alternatePhone !== undefined ? { alternatePhone: input.alternatePhone } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    select: { id: true, name: true, phone: true, version: true, updatedAt: true },
  });
  response.status(201).json({ customer, reused: false });
}));

customerRouter.patch('/:customerId', asyncHandler(async (request, response) => {
  const { customerId } = customerIdSchema.parse(request.params);
  const input = customerUpdateSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const updated = await prisma.customer.updateMany({
    where: { id: customerId, ownerId, archivedAt: null },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.alternatePhone !== undefined ? { alternatePhone: input.alternatePhone } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) throw notFound();
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, ownerId },
    select: { id: true, name: true, phone: true, alternatePhone: true, address: true, notes: true, version: true, updatedAt: true },
  });
  response.json({ customer });
}));

customerRouter.post('/:customerId/archive', asyncHandler(async (request, response) => {
  const { customerId } = customerIdSchema.parse(request.params);
  const { ownerId } = getAuthContext(request);
  const archivedAt = new Date();
  const result = await prisma.customer.updateMany({
    where: { id: customerId, ownerId, archivedAt: null },
    data: { archivedAt, version: { increment: 1 } },
  });
  if (!result.count) throw notFound();
  response.status(204).end();
}));
