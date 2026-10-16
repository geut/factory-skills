import { z } from 'zod';

// Schemas more than one group of routes uses.

export const TicketKey = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .meta({
    description: 'A ticket key: the name of its factory directory, `<slug>-<hash8>`.',
    example: 'geut-factory-skills-42-ab12cd34',
    id: 'TicketKey',
  });

export const TicketParams = z.object({ key: TicketKey });
