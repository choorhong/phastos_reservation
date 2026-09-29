# Kafka event design

This app uses a single Kafka topic for reservation lifecycle events.

## Topic

- `reservation-events`

The topic is created with 12 partitions, with the partition count defined in the Kafka contract file.

## Event types

All events share one topic but different event types in the payload:

- `ReservationRequested`
- `ReservationConfirmed`
- `ReservationCancelled`
- `SlotReleased`

Each event is wrapped in an envelope:

- `eventId`
- `eventType`
- `occurredAt`
- `version`
- `slotId`
- `locationId`
- `correlationId`
- `payload`

## Partitioning strategy

Messages are keyed by `slotId`:

- `key: args.slotId`

This ensures all events for one slot land in the same Kafka partition.

This is intentional because the app needs the lifecycle of a slot to be consumed in order:

- requested
- confirmed/cancelled
- slot released

Kafka preserves ordering within a single partition, so this design keeps the slot lifecycle consistent.

## Why one topic instead of multiple topics

The app intentionally uses one topic with multiple event types instead of splitting by event type.

This is because ordering is only guaranteed within one partition of one topic. For slot lifecycle correctness, all slot events must remain ordered together.

## Producer behavior

The producer sends messages with:

- `topic = reservation-events`
- `key = slotId`
- `value = JSON.stringify(eventEnvelope)`
- headers include `eventType` and `eventId`

## Consumer behavior

The consumer subscribes to the single topic and reads from the beginning of the active stream for the consumer group (`fromBeginning: false` in the current setup).

## Summary

- 1 topic: `reservation-events`
- multiple event types in the same topic
- 12 partitions
- partition key: `slotId`
- same slot => same partition => ordered lifecycle
