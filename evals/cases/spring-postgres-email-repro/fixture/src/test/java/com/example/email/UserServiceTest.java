package com.example.email;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock UserRepository repository;
    @InjectMocks UserService service;

    @Test
    void trimsAndLowercasesEmailBeforeLookup() {
        User user = new User("lee@example.com");
        when(repository.findByEmail("lee@example.com")).thenReturn(Optional.of(user));

        assertTrue(service.findByEmail(" Lee@Example.com ").isPresent());
        verify(repository).findByEmail("lee@example.com");
    }
}
