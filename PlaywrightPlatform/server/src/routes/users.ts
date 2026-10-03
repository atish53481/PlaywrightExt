import type { FastifyInstance } from 'fastify';
import { parse, shape } from '../http';
import { actorOf, adminOnly } from '../plugins/auth';
import { idParams, toUserDto } from '../schemas/common';
import { createUserBody, updateUserBody, userListResponse, userResponse } from '../schemas/users';
import type { UserService } from '../services/user-service';

export interface UserRouteDeps {
  users: UserService;
}

export async function userRoutes(app: FastifyInstance, deps: UserRouteDeps): Promise<void> {
  app.get('/users', { preHandler: adminOnly }, async () => {
    const items = await deps.users.list();
    return shape(userListResponse, { items: items.map(toUserDto) });
  });

  app.post('/users', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(createUserBody, req.body);
    const user = await deps.users.create(actorOf(req), body);
    return reply.status(201).send(shape(userResponse, { user: toUserDto(user) }));
  });

  app.put('/users/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateUserBody, req.body);
    const user = await deps.users.update(actorOf(req), id, body);
    return shape(userResponse, { user: toUserDto(user) });
  });
}
