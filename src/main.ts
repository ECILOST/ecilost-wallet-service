import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('wallet');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global y no por controlador: asi un endpoint nuevo no puede responder otro formato de
  // error por olvido. Es el mismo contrato que publica ecilost-catalog-service.
  app.useGlobalFilters(new ProblemDetailsFilter());

  await app.listen(process.env.PORT ?? 3002);
}

void bootstrap();
