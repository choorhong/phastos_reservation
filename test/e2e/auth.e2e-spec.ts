import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  bearer,
  createApp,
  decodeJwt,
  http,
  loginAdmin,
  registerUser,
  TestUser,
  unique,
} from './support';

describe('auth and access control (e2e)', () => {
  let app: INestApplication;
  let user: TestUser;

  beforeAll(async () => {
    app = await createApp();
    user = await registerUser(app);
  });

  afterAll(() => app.close());

  describe('register', () => {
    it('creates a user-role account and returns a token', async () => {
      const email = `${unique('new')}@test.local`;
      const res = await http(app)
        .post('/auth/register')
        .send({ email, password: 'password123' })
        .expect(201);
      expect(decodeJwt(res.body.accessToken).role).toBe('user');
    });

    it('rejects a duplicate email', async () => {
      await http(app)
        .post('/auth/register')
        .send({ email: user.email, password: 'password123' })
        .expect(409);
    });

    it.each([
      ['a malformed email', { email: 'not-an-email', password: 'password123' }],
      ['a short password', { email: 'short@test.local', password: 'short' }],
      ['a missing password', { email: 'nopass@test.local' }],
    ])('rejects %s', async (_label, body) => {
      await http(app).post('/auth/register').send(body).expect(400);
    });

    it('cannot be used to self-register as an admin', async () => {
      const res = await http(app)
        .post('/auth/register')
        .send({ email: `${unique('sneaky')}@test.local`, password: 'password123', role: 'admin' })
        .expect(201);
      expect(decodeJwt(res.body.accessToken).role).toBe('user');
    });
  });

  describe('login', () => {
    it('returns a token for the right credentials', async () => {
      const res = await http(app)
        .post('/auth/login')
        .send({ email: user.email, password: 'password123' })
        .expect(200);
      expect(decodeJwt(res.body.accessToken).sub).toBe(user.userId);
    });

    it('rejects a wrong password and an unknown email the same way', async () => {
      const wrongPassword = await http(app)
        .post('/auth/login')
        .send({ email: user.email, password: 'wrong-password' })
        .expect(401);
      const unknownEmail = await http(app)
        .post('/auth/login')
        .send({ email: 'nobody@test.local', password: 'password123' })
        .expect(401);
      expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
    });

    it('logs the bootstrapped admin in with the admin role', async () => {
      const admin = await loginAdmin(app);
      expect(decodeJwt(admin.token).role).toBe('admin');
    });
  });

  describe('protected routes', () => {
    const someId = randomUUID();
    const routes: [string, string][] = [
      ['get', '/locations'],
      ['get', '/slots'],
      ['get', '/reservations'],
      ['get', `/reservations/${someId}`],
      ['post', '/reservations'],
      ['post', `/reservations/${someId}/confirm`],
      ['post', `/reservations/${someId}/cancel`],
      ['post', '/locations'],
      ['post', '/slots/generate'],
      ['patch', `/slots/${someId}`],
    ];

    it.each(routes)('%s %s needs a token', async (method, path) => {
      await (http(app) as any)[method](path).expect(401);
    });

    it('rejects a garbage token and a tampered token', async () => {
      await http(app).get('/locations').set('Authorization', bearer('garbage')).expect(401);
      const tampered = user.token.slice(0, -3) + (user.token.endsWith('aaa') ? 'bbb' : 'aaa');
      await http(app).get('/locations').set('Authorization', bearer(tampered)).expect(401);
    });

    it('serves a valid token', async () => {
      await http(app).get('/locations').set('Authorization', bearer(user.token)).expect(200);
    });
  });

  describe('admin-only endpoints', () => {
    const adminOnly: [string, string, object][] = [
      ['post', '/locations', { name: 'X', address: 'Y', timezone: 'Asia/Singapore' }],
      ['post', '/slots/generate', {}],
      ['patch', `/slots/${randomUUID()}`, { capacity: 1 }],
    ];

    it.each(adminOnly)('%s %s is forbidden to a regular user', async (method, path, body) => {
      await (http(app) as any)
        [method](path)
        .set('Authorization', bearer(user.token))
        .send(body)
        .expect(403);
    });

    it('lets the admin through', async () => {
      const admin = await loginAdmin(app);
      await http(app).post('/slots/generate').set('Authorization', bearer(admin.token)).expect(201);
    });
  });
});
