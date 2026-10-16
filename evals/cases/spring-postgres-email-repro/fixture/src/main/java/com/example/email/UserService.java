package com.example.email;

import java.util.Locale;
import java.util.Optional;
import org.springframework.stereotype.Service;

@Service
public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public Optional<User> findByEmail(String email) {
        if (email == null) return Optional.empty();
        return repository.findByEmail(email.toLowerCase(Locale.ROOT));
    }
}
